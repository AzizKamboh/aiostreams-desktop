# Validation report

Implementation based on upstream `76a5d6da6d1babf885c7f65a2e19bbd55401a26d`.
Validation date: 2026-11-12. This report distinguishes executed checks from
planned native Windows acceptance.

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
  SDK/CRT. PE inspection confirms an x86-64 Windows GUI executable. It was not run
  on Windows, and an executable alone is not the complete installable payload.
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

## Windows acceptance still required

The prepared workflow builds Windows x64 native dependencies, ffprobe, Rust app,
fixed WebView2 and the Velopack installer/portable archive. It runs server smoke
with bundled Node, a Windows process-manager fixture (including descendant
cleanup), and a second smoke with developer runtime paths removed.

At this report revision that workflow has not yet completed. No Windows installer
or portable artifact is claimed. Actual fresh installation, upgrade/data retention,
DPAPI execution, Job Object behavior, WebView2 rendering, mpv video/audio output,
subtitles/audio tracks and a machine without developer runtimes require native
execution. Removing PATH entries on a CI machine is not a clean-machine test.

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
- The integrated upstream updater is disabled. Use a later integrated installer
  with the same package identity. Windows x64 is the initial packaging target.
- Distribution still requires reviewing final dependency notices and supplying
  corresponding source for bundled copyleft libraries, in addition to this app.
