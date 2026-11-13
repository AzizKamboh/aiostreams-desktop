# Validation report

Implementation based on upstream `76a5d6da6d1babf885c7f65a2e19bbd55401a26d`.
Validation date: 2026-11-12. This report distinguishes executed checks from
remaining acceptance limits.

## Executed in Linux

- Full Node 24.22.1 / pnpm 11.0.8 build: crypto, core, server, configuration
  frontend and browsing web interface passed. Final standalone client build passed.
- Desktop private-boundary tests: 5 passed. Core HTTP/credential-redirect tests:
  12 passed. Browser-storage/port-migration tests: 3 passed.
- Real-server smoke: 11 passed. A generated local addon and CC0 audio/video
  fixture exercised configuration import/export, profiles, aggregation, generated
  playback URLs, complete/ranged proxy transfer, local redirects/nested proxying,
  ffprobe recognition and FFmpeg decoding. Also checked auth, foreign Origin and
  Host rejection, credential non-leakage, restart/new port, crash recovery, stdin
  shutdown/EOF, occupied port ownership, and spaces/non-English data paths.
- Production-only runtime staging: 517 dependency notice entries, no symlinks or
  junctions. Staged server smoke: 10 passed, including after moving the stage
  outside the development repository so parent node_modules cannot hide missing
  dependencies. This was a Linux payload, not Windows binaries.
- Hidden-path checks: trusted configuration/client/source files served from
  `.Apps/空間`; arbitrary dotfiles remained blocked.
- Rust backend manager: 6 isolated tests passed using a real copied Node runtime
  and a fixture backend. Covered startup, health/ownership, occupied/raced ports,
  restart/crash, saved storage/key guards, prior-port URL migration and cleanup.
  Linux uses its test storage implementation; these tests do not execute DPAPI.
- Windows x64 target: cross-compiled/type-checked tests and successfully linked
  the release desktop executable using Rust 1.99.1, cargo-xwin and the Windows
  SDK/CRT. PE inspection confirms an x86-64 Windows GUI executable. That cross-built executable was not executed; the native Windows build
  and complete installable payload were tested separately as described below.
- Chromium/Playwright: actual embedded configuration dashboard and built browsing
  interface rendered; navigation, remote-mode selection, failure presentation and
  native restart/open-logs command dispatch passed. The native bridge was
  simulated for these browser checks. No uncaught JavaScript errors occurred.
  One external asset hit the test browser's proxy-CA trust error; the local UI
  passed. These checks do not exercise mpv/WebView2.
- PowerShell packaging syntax was parsed. Source archive was unpacked, changed,
  given an additional source file, and archived again without `.git`; metadata
  generation also worked from that source-only checkout.
- `cargo test -p aiostreams-desktop-core` compiled successfully but discovered
  zero tests; it is not counted as behavioral coverage. `git diff --check` passed.

## Release 0.1.0 candidate

Changes on `main` after the validated run below, prepared without a local build
(this environment could not install the Node 24 toolchain):

- Every imported upstream workflow job now runs only in `Viren070/AIOStreams`, so
  pushes to this repository's `main` cannot trigger upstream release, nightly,
  Docker or update-feed jobs.
- About/Diagnostics show the integrated version (from the packaging `-Version`)
  separately from the upstream desktop client and server versions.
- The workflow builds on pushes to `main` and can create a draft release.

Checked here: workflow YAML parses and every imported job carries the guard;
the Rust change passes `rustfmt --check`. Not yet run: TypeScript/Rust
compilation and the full Windows test suite for these changes. The release must
not be published until **Integrated Windows desktop** passes on this commit.

## Executed on native Windows CI

[Windows run 43262406460](https://github.com/AzizKamboh/aiostreams-desktop/actions/runs/43262406460)
built the native Windows x64 application, production Node dependencies, ffprobe,
fixed WebView2 payload, per-user Setup.exe and portable ZIP from source commit
`11e90b905e5e330232abaef7f42959c12c20858b`. All build, functional test and artifact
upload steps passed.

- [Installer, portable build, source and checksums](https://github.com/AzizKamboh/aiostreams-desktop/actions/runs/43262406460/artifacts/13966812042)
- [Native test results and screenshot](https://github.com/AzizKamboh/aiostreams-desktop/actions/runs/43262406460/artifacts/13966353469)

- Six native Rust tests passed, including DPAPI round-trip/replacement and
  non-English paths. The separately invoked process-manager lifecycle fixture
  passed: occupied ports, crash/restart, persistent protected storage, and
  Job Object descendant cleanup.
- The bundled production backend passed all 10 smoke checks on Windows, then
  passed them again with developer runtime-discovery paths removed from PATH.
  These exercise configuration, aggregation, proxy/range transfer, ffprobe,
  persistence, port ownership, shutdown and credential boundaries.
- The actual per-user installer ran into a fresh directory with spaces and
  Japanese characters. The installed native app opened its bundled WebView2,
  started its private backend and displayed the real configuration dashboard.
  A second app launch exited through the single-instance guard.
- A generated CC0 audio/video fixture played through an authenticated embedded
  server proxy in native mpv. Playback time advanced; pause, seek, audio-track
  off/on selection and external subtitle off/on selection passed through the
  real native IPC bridge. CDP drove the installed WebView2; no native bridge,
  player or backend was mocked. This test does not automate choosing a title
  from an account-backed catalog.
- The native restart action reconnected the client; application exit released
  the backend listener. A test-only newer installer upgraded the same install,
  and a second launch decrypted the saved key and retained server settings.
  The test-only version is excluded from downloadable release artifacts.

CI uses Windows Server 2025, software D3D11 rendering and a null audio output
because the runner has no physical speaker. The test checks real native playback
and track controls, but does not verify audible output, a physical GPU/HDR,
Windows 10/11-specific behavior, or every hardware codec. PATH removal is not a
clean-machine test: the hosted runner has development tools installed and runs
under its configured runner account. A standard-user clean-PC acceptance pass
remains advisable. Installer signing is not configured.

## Remaining functional boundaries

- Real paid/provider accounts were not available. Addon/debrid/Usenet/indexer
  implementations were retained, not certified against every external service.
- Optional FUSE mounting is Linux-only upstream. This package adds no Windows
  filesystem driver. HTTP streaming/WebDAV remain available through existing code.
- Upstream Jellyfin HLS/transcoding endpoints return 501; its built-in proxy
  relays raw HLS playlists without resolving relative child URIs. External direct
  play is retained. No transcoder/playlist rewriting was invented here.
- DPAPI protects the server key and stable native client snapshot. Active
  upstream browser localStorage credentials remain in the per-user WebView
  profile. This does not isolate malicious processes under the same Windows user.
- Up to 0.2.2 the updater was disabled. From 0.3.0 the integrated updater is
  used; see "Release automation and updates" below for what has been run.
  Windows x64 is the initial packaging target.
- Distribution still requires reviewing final dependency notices and supplying
  corresponding source for bundled copyleft libraries, in addition to this app.

## Release automation and updates (0.3.0 work)

Recorded separately from the 0.1.0–0.2.2 results above. Executed on a Linux
development container while this work was prepared:

| Check | Result |
| --- | --- |
| `node --test scripts/upstream/*.test.mjs scripts/release/*.test.mjs` | passed |
| `cargo test --locked --workspace` in `packages/desktop` (Linux build; includes `update_policy` and integrated updater unit tests) | passed |
| `vitest run packages/web/tests/embedded-*.test.ts` | passed |
| `node scripts/release/release.mjs check` | passed |
| `sync.mjs detect` against the real upstream repository | passed: newest stable upstream release is `desktop-v0.24.0`, already integrated |
| `sync.mjs prepare` against a local copy of upstream with a test tag on upstream `main` (24 commits ahead) | clean merge, report generated |
| `sync.mjs prepare` with a deliberately conflicting upstream commit | conflict committed with markers, draft report, `check-markers` fails as intended |
| `feed-check` (Velopack 1.2.161 client) against local HTTP feeds | valid update found and downloaded; foreign package ID refused; tampered package rejected by checksum; missing feed, wrong channel and unreachable server fail cleanly; up-to-date copy gets no offer |
| `release.mjs verify-feed` / `check-forward` / `merge-feed` on fixture feeds | passed / rejected as intended |

Not executable in that container (no Windows; `pnpm install` could not fetch
one GitHub-hosted dependency tarball): the full TypeScript build, the
Windows-only Rust code paths (`cfg(windows)`), and the native Windows tests,
including `scripts/desktop/native-update.mjs` (real installs and updates:
missing/unavailable/malformed feeds, foreign package, corrupted package,
older version, invalid channel, successful download, install request during
playback, install on close with data kept, install and restart, portable
update). Those run in **Integrated Windows desktop** on `windows-2025`; their
results are that workflow's run on the pull request that introduced them.

Not tested anywhere yet: an update from a *published* 0.3.0 to a later
published release through the live feed (possible only once two releases
exist; *Post-release validation* covers discovery and download from the live
feed after each release), an update interrupted mid-install (Velopack's
responsibility; not simulated), and real provider accounts.
