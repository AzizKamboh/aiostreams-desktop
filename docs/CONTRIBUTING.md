# Contributing

Thank you for helping. This repository is an **unofficial Windows
distribution** of [AIOStreams](https://github.com/Viren070/AIOStreams); most
of its code belongs to upstream.

## Where a change belongs

| Change | Where |
| --- | --- |
| Providers, addons, indexers, sorting, formatting, server APIs | [upstream](https://github.com/Viren070/AIOStreams) |
| Browsing interface, player behaviour, dashboard, translations | upstream |
| Bugs that also happen in upstream's server or apps | upstream |
| Bundling, local server supervision, account setup, Windows storage | here |
| Packaging, versioning, releases, update feeds, the integrated updater | here |
| Upstream synchronisation, integration tests and docs | here |

A fix for an upstream bug that the integration exposed should be a small,
separate commit that can also be offered upstream as a pull request from a
fork. Do not open upstream issues for integrated-build behaviour.

## Rules for upstream files

- Prefer a new integration-owned file over editing an upstream file. Hook
  into upstream with the smallest change, with a comment starting
  `AIOStreams Integrated:`.
- Keep upstream formatting, imports, line endings and byte-order marks; do
  not reformat or refactor upstream code.
- Gate integration behaviour on `appBridge()?.backend` (web) or the embedded
  build (native), so upstream's behaviour is unchanged elsewhere.
- Add every new hook to [UPSTREAM-HOOKS.md](embedded-desktop/UPSTREAM-HOOKS.md)
  and [`scripts/upstream/hooks.json`](../scripts/upstream/hooks.json) (a test
  checks the listed paths exist).
- Never edit upstream workflows except to keep the
  `if: github.repository == 'Viren070/AIOStreams'` guards.

## Development

```sh
pnpm install
pnpm build
AIOSTREAMS_DESKTOP_BUILD=1 pnpm -F @aiostreams/web build:standalone
node scripts/desktop/smoke.mjs                # real backend process, fixtures
pnpm exec vitest run packages/server/src/desktop.test.ts packages/web/tests/embedded-*.test.ts
node --test scripts/upstream/*.test.mjs scripts/release/*.test.mjs
node scripts/release/release.mjs check
(cd packages/desktop && cargo test --locked --workspace)   # Linux needs libgtk-4-dev libwebkitgtk-6.0-dev
```

The Windows package and native tests need Windows:
[embedded-windows-build.md](embedded-windows-build.md). Pull requests run
Pull Request CI and, when relevant files change, the full Windows build and
native tests.

## Pull requests

- Conventional commit messages (`feat(updates): …`, `fix(server): …`,
  `chore(upstream): …`).
- One concern per pull request: never mix an upstream sync, a refactor and
  an update-system change.
- New UI strings: add them to `packages/web/src/locales/en-GB.po` and
  `messages.pot` (appended, as existing integration strings are).
- Describe what you tested and on what; say what you could not test. Real
  provider accounts are never required or used in CI.
- Security issues: report privately ([SECURITY.md](../.github/SECURITY.md)).
