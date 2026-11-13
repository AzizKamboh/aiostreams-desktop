# Architecture of AIOStreams Integrated

AIOStreams Integrated is upstream [Viren070/AIOStreams](https://github.com/Viren070/AIOStreams)
plus a thin, separately owned integration layer. This page describes that
layer; upstream's own architecture is in [CLAUDE.md](../CLAUDE.md) and
upstream's documentation.

## Runtime

```
aiostreams-desktop.exe  (upstream Rust shell: tao/wry → WebView2, libmpv)
│
├─ backend.rs (integration) ── node.exe packages/server/dist/server.js   (upstream server)
│    · 127.0.0.1, free port, per-launch capability, Host/Origin checks (server/src/desktop.ts)
│    · working dir %LOCALAPPDATA%\AIOStreams Integrated\backend, SQLite
│    · server key, accounts and client sign-ins in DPAPI files
│    · readiness event + /api/v1/health; stdin shutdown; Windows Job Object
│    · restarts once after an unexpected exit
│
├─ WebView2 page: upstream web client (packages/web, standalone build) served by the local server
│    · integration UI: account setup, Local server, Updates, dashboard panel (embedded-*.tsx)
│    · upstream dashboard/configuration (packages/frontend) in an in-app panel
│    · native bridge window.aiostreamsApp — only the app's own page may use it
│
├─ mpv (upstream player integration); local media URLs get the capability as a query parameter
│
└─ updates_integrated.rs (integration) ── Velopack ── github.com/<repo>/releases/download/updates-<channel>/
```

Relayed provider content (proxy, streams, WebDAV, builtins, Jellyfin and
Stremio APIs) is served with `Content-Security-Policy: sandbox`, so it can
never act as the app.

## Ownership

| Upstream owns | The integration owns |
| --- | --- |
| Server, APIs, providers, addons, indexers, stream pipeline | Bundling Node, server, web client, mpv, ffprobe |
| Catalogs, metadata, subtitles | Starting, supervising and stopping the local server |
| Browsing interface, dashboard, configuration page | Private loopback access and its authentication |
| Desktop shell, mpv playback, bridge protocol | DPAPI storage, Windows data folders |
| Authentication and permission semantics | First-run account setup, Local server settings, dashboard panel |
| Security and compatibility fixes | Packaging, versioning, releases, update feeds and updater |
| | Upstream synchronisation, integration tests and docs |

Integration code lives in files upstream does not have; upstream files carry
small, commented hooks. The full list, kept current, is
[embedded-desktop/UPSTREAM-HOOKS.md](embedded-desktop/UPSTREAM-HOOKS.md) and
its machine-readable form [`scripts/upstream/hooks.json`](../scripts/upstream/hooks.json).

## Adapter boundaries

- **Server**: `server/src/desktop.ts` and `desktop-routes.ts` wrap the
  upstream Express app (`installDesktop()` before upstream middleware).
  `core/src/utils/desktop-env.ts` translates desktop settings into upstream's
  environment variables before upstream parses them.
- **Native**: `embedded.rs` routes integration messages (`backend-*`,
  `integrated-update-*`) before upstream's bridge parser, so the upstream
  bridge protocol (`PROTOCOL_VERSION`) is unchanged.
- **Updater**: `main.rs` compiles `updates_integrated.rs` in place of
  upstream's `updates.rs` with one `#[path]` attribute; upstream's file stays
  byte-identical and sync reports flag its changes ("shadowed files").
- **Web**: `lib/embedded-*.ts` and `components/shell/embedded-*.tsx`, mounted
  from a few hooks in upstream components, all gated on `appBridge()?.backend`
  so the upstream build behaves as upstream.

When an upstream change breaks an adapter, fix the adapter (or add a
version-aware branch to it) in the sync pull request; do not fork the
upstream component. If that is impossible, block the upstream release
temporarily ([UPSTREAM-SYNC.md](UPSTREAM-SYNC.md#blocking-an-upstream-release)).

## Build and release pipeline

| Workflow | Trigger | Permissions | Does |
| --- | --- | --- | --- |
| Pull Request CI (`pr-ci.yml`) | PRs, pushes to main, dispatch | read | conflict markers, upstream workflow guards, tooling tests, version consistency, TypeScript build/tests, backend smoke, Rust tests (change-aware) |
| Integrated Windows desktop (`embedded-desktop.yml`) | pushes to main, relevant PRs, dispatch | read; release job: contents/attestations write | real Windows build, native installer/upgrade/playback/update tests, feed verification; draft releases |
| Release publishing (`release-publish.yml`) | a release is published | contents write (feed job only) | verifies a published release, updates its update feed |
| Post-release validation (`post-release-validation.yml`) | after publishing, weekly, dispatch | read | public downloads, public feed, Velopack update discovery |
| Upstream Sync (`upstream-sync.yml`) | daily, dispatch | detect read; sync job contents/PR/issues/actions write | merges new upstream releases into reviewed PRs |
| Dependency maintenance (`dependency-maintenance.yml`) | weekly, dispatch | read; PR job contents/PR write | Node runtime and action pins for integration-owned files |

Upstream's own workflows stay in the repository (they arrive with every
merge) but every job is limited to `Viren070/AIOStreams`, checked by Pull
Request CI.
