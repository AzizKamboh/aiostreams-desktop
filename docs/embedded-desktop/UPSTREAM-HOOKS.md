# Where the integration touches upstream code

Goal: keep upstream AIOStreams files as close to their original bytes as
possible, so that merging a new upstream release mostly means accepting it.
Integration logic lives in files upstream does not have; upstream files get
small, commented hooks that call into them.

Baseline: the upstream release recorded in
[`.github/upstream-sync.json`](../../.github/upstream-sync.json) (now
`desktop-v0.24.0`, commit `76a5d6da`). Upstream is an ancestor in Git
history, so the integrated-versus-upstream diff is:

```sh
base=$(jq -r .baseline.commit .github/upstream-sync.json)
git fetch --no-tags https://github.com/Viren070/AIOStreams.git "$base"
git diff --stat "$base" HEAD -- packages      # every integration change to upstream code
git diff "$base" HEAD -- packages/web/src/app  # one area in full
```

The machine-readable form of this page is
[`scripts/upstream/hooks.json`](../../scripts/upstream/hooks.json); sync pull
requests use it to flag affected hooks, and a test checks every path in it
exists. Process: [UPSTREAM-SYNC.md](../UPSTREAM-SYNC.md).

## Integration-owned files (upstream has none of these)

| File | Purpose |
| --- | --- |
| `packages/core/src/utils/desktop-env.ts` | Desktop env defaults; merges the internal `desktop` account with the user's `AIOSTREAMS_AUTH`; log redaction of desktop secrets |
| `packages/server/src/desktop.ts` | Private access boundary (token, Host/Origin checks), ready event, stdin shutdown |
| `packages/server/src/desktop-routes.ts` | `/__desktop/*` routes: session bootstrap, client files, source download, account list and Usenet account check |
| `packages/web/src/components/shell/embedded-desktop.tsx` | Embedded shell UI: status, Server settings, Diagnostics, local/remote switch |
| `packages/web/src/components/shell/embedded-accounts.tsx` | Account setup, "account ready" step, account management |
| `packages/web/src/components/shell/embedded-nav.tsx` | "AIOStreams Dashboard" sidebar/menu item, player button, sign-in links |
| `packages/web/src/components/shell/embedded-local-server.tsx` | Settings → Local server |
| `packages/web/src/lib/embedded-shell.ts` | Shell state shared with those hooks; active player registry; shortcuts |
| `packages/frontend/src/lib/desktop-embed.ts` | "Home" entry in the dashboard/configuration sidebars, only inside the app |
| `packages/web/src/lib/embedded-*.ts` | Local origin handling, settings persistence across ports, account rules |
| `packages/desktop/app/src/backend.rs`, `backend/*.rs`, `embedded.rs` | Node supervisor, DPAPI storage, accounts, Job Object |
| `packages/desktop/app/src/updates_integrated.rs`, `update_policy.rs` | Integrated updater: own feeds, package-identity check, backoff, playback-safe install |
| `packages/web/src/lib/embedded-updates.ts`, `embedded-update-state.ts`, `components/shell/embedded-updates.tsx` | Settings → Updates for the integrated updater |
| `scripts/desktop/*`, `.github/workflows/embedded-desktop.yml` | Build, packaging, native tests (`native-update.mjs`: real updates) |
| `scripts/upstream/*`, `.github/workflows/upstream-sync.yml`, `.github/upstream-sync.json` | Upstream synchronisation |
| `scripts/release/*`, `integrated-version.json`, `.github/workflows/{pr-ci,release-publish,post-release-validation,dependency-maintenance}.yml` | Versioning, release verification, feeds, CI |

## Hooks in upstream files

| Upstream file | Change | Why |
| --- | --- | --- |
| `core/src/utils/env.ts` | 1 import | Run `desktop-env.ts` before the environment is parsed |
| `core/src/logging/redact.ts` | 1 import, 2 lines | Always redact desktop secrets; never log sensitive data in desktop mode |
| `core/src/utils/http.ts` | 1 line | Compare origins, not string prefixes, before sending the internal secret (security fix worth offering upstream) |
| `server/src/app.ts` | 1 import, 1 call | `installDesktop()` before upstream middleware; 2 `sendFile` options for install paths containing a dot-folder |
| `server/src/server.ts` | 5 calls | Loopback-only listen, ready event, WebSocket gate, stdin shutdown; online datasets and Prowlarr indexers refresh in the background (`deferInDesktop`) instead of delaying startup |
| `server/src/routes/api/proxy.ts` | ~18 lines | Never forward desktop cookies/auth or the internal secret to media providers; never relay a provider's Set-Cookie or CSP onto the private origin |
| `server/src/routes/stremio/configure.ts` | 1 option | `dotfiles: 'allow'` for install paths |
| `web/src/app.tsx` | ~15 lines | Mount the embedded shell in the desktop build |
| `web/src/lib/hosts/shell/bridge.ts` | types only | Backend-state and account messages |
| `web/src/components/shell/layout.tsx` | 1 hook, footer lists | "AIOStreams Dashboard" next to Settings in every navigation layout |
| `web/src/app/settings/page.tsx` | 1 section entry | Settings → Local server |
| `web/src/app/sign-in/page.tsx` | 1 hook in `LinkRow` | Configuration/dashboard links (or "use this computer's server") on sign-in screens |
| `web/src/features/player/options.tsx` | 1 element | Server dashboard button in the player controls |
| `web/src/features/remote/remote-target.tsx` | 1 hook | Registers the active player so the panel can pause and resume it |
| `frontend/src/routes/dashboard-layout.tsx`, `frontend/src/app/configure/main-sidebar.tsx` | 1 import, 1 spread each | "Home" footer entry inside the desktop app |
| `web/src/lib/jellyfin/session.tsx`, `settings/index.ts`, `storage.ts`, `app/settings/account.tsx`, `components/media/no-catalogs.tsx` | 1–9 lines each | Local sign-in, Discord presence default off, storage change event, open configuration in-app |
| `web/rsbuild.config.ts`, `web/src/env.d.ts` | 1 constant | Server version shown in Diagnostics |
| `web/src/locales/en-GB.po`, `messages.pot` | appended entries | Source text for new UI strings |
| `desktop/app/src/main.rs` | small; `#[path = "updates_integrated.rs"] mod updates;`, `updates::apply`, `updates::observe_player` | Start the backend, integrated version; compile the integrated updater instead of upstream's; playback state for safe installs |
| `desktop/app/src/shell/tao_shell.rs` | small; `crate::updates::on_exit()` after `backend.stop()` | Trust the backend origin, route embedded messages; install a downloaded update after a normal shutdown |
| `desktop/app/src/platform/windows.rs`, `bridge.js` | small | App identity, integrated version |
| `desktop/app/Cargo.toml` | Windows API features | DPAPI, Job Objects, free disk space (`Win32_Storage_FileSystem`) |
| `web/src/app/settings/apps.tsx` | 1 import, 1 line | Integrated Settings → Updates instead of upstream's card, in the integrated app only |
| `web/src/components/shell/update-prompt.tsx` | 2 imports, 2 lines | Upstream's update notice waits while something plays (integrated app only) |
| `desktop/core/src/downloads.rs`, `logs.rs` | small | Authorise local download URLs; log redaction |

Upstream files keep their original byte-order marks and formatting so diffs show
only real changes.

## Shadowed upstream files

| Upstream file | Replaced by | Review on sync |
| --- | --- | --- |
| `desktop/app/src/updates.rs` | `updates_integrated.rs` (same public API) | Kept byte-identical to upstream and not compiled. Port upstream fixes that apply (Velopack API changes, new bridge update messages). |

## Integration-replaced files

Replaced wholesale; on a sync conflict `sync.mjs` keeps this repository's
version and lists upstream's change in the report for manual review.

| Path | Why |
| --- | --- |
| `README.md` | The integrated project's landing page; links upstream's README |
| `.github/ISSUE_TEMPLATE/` | Issue forms for this distribution; upstream-only bugs go upstream |

## Upstream workflows

Every job of every inherited upstream workflow carries
`if: github.repository == 'Viren070/AIOStreams'` (or adds that condition to
its existing `if:`), so nothing upstream publishes runs here. Pull Request CI
fails if a merge brings an unguarded job.

## Upstream behaviour the integration depends on

Check these when merging a new upstream release:

- `AIOSTREAMS_AUTH` / `AIOSTREAMS_AUTH_PERMISSIONS` syntax and permission names
  (`core/src/utils/env.ts`, `permissions.ts`). The account rules are mirrored
  in `web/src/lib/embedded-accounts.ts` and `desktop/app/src/backend/accounts.rs`.
- `checkAuthToken(credential, Permission.Service)` as the built-in Usenet
  service's authorisation (`core/src/debrid/aiostreams.ts`).
- Dashboard routes `/dashboard`, `/dashboard/usenet/providers` and
  `/stremio/configure` (`frontend/src/router.tsx`), opened in the panel.
- `footerItems` in the two frontend sidebars, `footerItems`/`menuItems` in
  `web/src/components/shell/layout.tsx`, `LinkRow` on sign-in screens,
  `OptionButtons` in the player and `useRemotePlayer` receiving the controller.
- Player key bindings (`web/src/lib/input/actions.ts`): the integration's
  Ctrl+, shortcuts must not collide with new upstream ones.
- `setSessionCookie` and the `/api/v1/health` endpoint.
- The desktop bridge protocol between `desktop/app` and `web/src/lib/hosts/shell`.

## Compatibility record

| | |
| --- | --- |
| Current upstream baseline | `desktop-v0.24.0` / server `v2.37.0`, commit `76a5d6da` (`.github/upstream-sync.json`) |
| Pending upstream changes | Open pull requests labelled `upstream-sync`; upstream `main` was 24 commits ahead with no newer stable release when this was written |
| Blocked upstream releases | none (`blocked` in `.github/upstream-sync.json`) |
| Compatibility patches | `core/src/remuxdb/adapter.test.ts`: stale expectation (see below) |

Patches made to adapt to an upstream change are listed here with the
upstream release that required them and the reason.

| Upstream file | Since | Patch | Reason | Remove when |
| --- | --- | --- | --- | --- |
| `packages/core/src/remuxdb/adapter.test.ts` ("maps audio and subtitle tracks") | `desktop-v0.24.0` | Assert only the mapped fields instead of the whole object | Upstream extended the shared wire format (`media-info/wire.ts`: `index`, `default`, accessibility flags) without updating this test; it fails at upstream `desktop-v0.24.0` and on upstream `main`. Upstream CI does not run tests; this repository's Pull Request CI does. Test-only, no runtime change. | Upstream fixes the test (a sync then conflicts on this hunk; take upstream's version) |

## Tests covering each critical hook

| Hook | Tests |
| --- | --- |
| Private access boundary (`desktop.ts`, Host/Origin, capability) | `packages/server/src/desktop.test.ts`, `scripts/desktop/smoke.mjs` |
| Accounts / `AIOSTREAMS_AUTH`, built-in Usenet check | `packages/web/tests/embedded-accounts.test.ts`, `backend/accounts.rs` tests, `native-smoke.mjs` |
| Storage across ports, DPAPI | `packages/web/tests/embedded-storage.test.ts`, `backend.rs` tests, `native-smoke.mjs` (restart, upgrade) |
| Proxy cookie/CSP isolation, sandboxed relayed content | `desktop.test.ts`, `smoke.mjs` |
| Dashboard routes, Home entry, shortcuts | `native-smoke.mjs` |
| mpv bridge: playback, pause, seek, audio and subtitle tracks | `native-smoke.mjs` (fullscreen transitions are not automated yet) |
| Integrated updater and feed | `update_policy.rs` / `updates_integrated.rs` tests, `embedded-updates.test.ts`, `native-update.mjs`, `scripts/release/feed-check`, `scripts/release/lib.test.mjs` |
| Upstream workflow guards, conflict markers | `sync.mjs check-guards`, `check-markers` (Pull Request CI) |
