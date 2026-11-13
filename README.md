<h1 align="center">AIOStreams for Windows (integrated build)</h1>

<p align="center">
  <strong>The AIOStreams desktop app with its own private AIOStreams server built in — one Windows install, no Docker, no separate server.</strong>
</p>

<p align="center">
  <a href="https://github.com/AzizKamboh/aiostreams-desktop/releases/latest"><img src="https://img.shields.io/github/v/release/AzizKamboh/aiostreams-desktop?style=for-the-badge&logo=github&label=integrated%20release" alt="Latest integrated release"></a>
  <a href="https://github.com/AzizKamboh/aiostreams-desktop/actions/workflows/embedded-desktop.yml"><img src="https://img.shields.io/github/actions/workflow/status/AzizKamboh/aiostreams-desktop/embedded-desktop.yml?branch=main&style=for-the-badge&logo=windows&label=windows%20build" alt="Windows build"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/AzizKamboh/aiostreams-desktop?style=for-the-badge" alt="License: AGPL-3.0"></a>
</p>

> [!IMPORTANT]
> **Unofficial.** This is an independent Windows distribution of
> [**AIOStreams**](https://github.com/Viren070/AIOStreams), created by
> **[Viren070](https://github.com/Viren070) and the AIOStreams contributors**.
> It is not made, endorsed or supported by Viren070 or the AIOStreams project.
> Report problems with this build [here](https://github.com/AzizKamboh/aiostreams-desktop/issues),
> not upstream. For AIOStreams itself — the addon, its documentation and its
> community — go to [aiostreams.org](https://aiostreams.org) and the
> [upstream repository](https://github.com/Viren070/AIOStreams).

## What it is

Upstream AIOStreams is a self-hosted server (usually run with Docker) that
gathers your Stremio addons, debrid services and Usenet into one filtered,
sorted list, plus apps — including a Windows desktop client — to browse and
play it. This build **combines the upstream server and the upstream desktop
client into one Windows application**: the app starts its own private
AIOStreams server on your PC, signs itself in, and plays through mpv. Every
streaming, provider, addon, browsing and dashboard feature is upstream's own
code, unchanged in function.

| | Version |
| --- | --- |
| Current integrated release | **[0.2.2](https://github.com/AzizKamboh/aiostreams-desktop/releases/tag/v0.2.2)** (next: 0.3.0, with automatic updates) |
| Upstream server inside it | 2.37.0 |
| Upstream desktop client inside it | 0.24.0 (upstream tag `desktop-v0.24.0`, commit `76a5d6da`) |

The integrated app has its **own version number**, separate from the two
upstream versions; Settings → Updates and Settings → Local server show all
three.

## Download

From the [latest release](https://github.com/AzizKamboh/aiostreams-desktop/releases/latest):

| File | Use |
| --- | --- |
| `aiostreams-integrated-win-x64-Setup.exe` | Installer (recommended). Per-user, no administrator rights, installs WebView2 if missing. |
| `aiostreams-integrated-win-x64-Portable.zip` | Portable copy. Needs the WebView2 runtime (present on Windows 11 and updated Windows 10). |
| `aiostreams-integrated-source.tar.gz` | Complete corresponding source (AGPL-3.0). |
| `SHA256SUMS.txt` | Checksums of every file. |

Windows 10/11 x64. Builds are currently **unsigned**, so SmartScreen may warn
on first run ("More info" → "Run anyway"). From 0.3.0 each file also has a
[build provenance attestation](docs/RELEASE-PROCESS.md#verifying-a-download):
`gh attestation verify <file> -R AzizKamboh/aiostreams-desktop`.

## Features

- Everything in the upstream **desktop client**: the browsing interface, the
  native mpv player (hardware decoding, audio/subtitle tracks, seeking,
  fullscreen, picture-in-picture), downloads, Discord presence (off by default).
- Everything in the upstream **server**: addons, debrid and Usenet providers,
  indexers, filtering, sorting, formatting, the AIOStreams Dashboard and the
  configuration page — running locally, opened inside the app.
- **First-run account setup** for upstream's `AIOSTREAMS_AUTH`, so built-in
  Usenet streaming works without editing environment variables.
- **Remote mode**: switch to a remote AIOStreams or Jellyfin server at any
  time, and back.
- **Automatic updates** (from 0.3.0) of the whole app from this repository.

## How the bundled server works

```
aiostreams-desktop.exe (Rust, WebView2, libmpv)
 ├─ starts node.exe + the upstream AIOStreams server, bound to 127.0.0.1 on a free port
 │    data: %LOCALAPPDATA%\AIOStreams Integrated\backend (SQLite, cache)
 ├─ loads the upstream web client from that server, with a private per-launch token
 └─ plays streams in mpv; stops the server when the app closes (Job Object as backstop)
```

Only the app can reach the server: it listens on loopback only, checks Host
and Origin, and requires a per-launch capability. The server key and saved
sign-ins are encrypted with Windows DPAPI. Details:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Install and first run

1. Run `aiostreams-integrated-win-x64-Setup.exe`. It installs for your Windows
   user and adds an **AIOStreams** Start-menu entry.
2. The app starts its local server (the first start can take a minute while
   upstream data downloads) and asks you to create an **AIOStreams account**
   — the equivalent of `AIOSTREAMS_AUTH`. You can skip it if you do not use
   built-in Usenet.
3. Open **AIOStreams Dashboard** (next to Settings, or Ctrl+,) to add
   providers and addons, and the configuration page (Ctrl+Shift+,) to set up
   your streams. Escape returns to the library.

The full guide, including built-in Usenet: [README-INTEGRATED.md](README-INTEGRATED.md).

## Updates

From 0.3.0 the app keeps itself up to date from **this repository's
releases only** — never from upstream's separate desktop-only app, which
would remove the built-in server.

- It checks shortly after starting and every six hours, downloads in the
  background and verifies the package.
- The update installs **when you close the app**, or immediately with
  **Install and restart** in Settings → Updates. It never restarts while
  something is playing.
- Channels: **Stable** (default) and **Preview** (earlier builds, same tests,
  more risk). Your data, accounts, server key and settings are kept.
- 0.2.x has no updater: install 0.3.0 once by running its Setup over the old
  install.

Details, recovery and rollback: [docs/AUTO-UPDATE.md](docs/AUTO-UPDATE.md).

## Local and remote server

Settings → **Local server** → *Connection* switches between the built-in
server and upstream's remote-server picker (any AIOStreams or Jellyfin
server). The local server keeps running in the background until you exit, so
switching back is instant. Remote users are never asked to create a local
account.

## Supported platforms

Windows 10 and 11, x64. Other platforms are not built by this project; use
[upstream's apps](https://aiostreams.org/download) and Docker server there.

## Known limitations

- Unsigned builds (SmartScreen warning).
- Upstream's Linux FUSE mount and Jellyfin HLS/transcoding endpoints are not
  available; direct play is.
- Account passwords and the server key reach the local server as environment
  variables: DPAPI protects them from other Windows users and other PCs, not
  from malware running as you.
- Automated tests use fixtures; real debrid, Usenet and addon accounts are
  not tested in CI ([validation report](docs/embedded-desktop/VALIDATION.md)).
- Going back to an older version is not automatic and may be unsafe after a
  database migration ([rollback](docs/AUTO-UPDATE.md#rollback-and-recovery)).

## Security and privacy

No telemetry is added; tracker playback reporting and Discord presence are
off by default. Providers, addons and metadata sources receive the requests
their features need, as in upstream. Relayed provider content is sandboxed
from the app, only the app's own page may use the native player bridge, and
logs are redacted. Updates come from this repository's feeds only and are
checked for package identity and checksums. Report vulnerabilities privately:
[SECURITY.md](.github/SECURITY.md).

## Build from source

The Windows package is built on native Windows x64 with Node 24, pnpm 11,
Rust, .NET 9 (for Velopack's `vpk`) and MSYS2 (for ffprobe):

```powershell
bash scripts/desktop/build-ffprobe.sh          # in MSYS2 MINGW64
./scripts/desktop/package-windows.ps1 -Version 0.3.0-dev.1
./scripts/desktop/test-windows.ps1             # installer, playback, upgrade and update tests
```

Pinned runtimes, payload layout and options: [docs/embedded-windows-build.md](docs/embedded-windows-build.md).
Server and web development follow upstream (`pnpm install`, `pnpm build`, `pnpm test`).

## Contributing

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md). Changes to AIOStreams
itself (providers, addons, the server, the player) belong
[upstream](https://github.com/Viren070/AIOStreams); this repository takes
integration, packaging, update and Windows-specific changes, and keeps
upstream files as close to upstream as possible
([where the integration touches upstream](docs/embedded-desktop/UPSTREAM-HOOKS.md)).

## Upstream synchronisation

A daily workflow detects new stable upstream server and desktop releases,
merges them into a branch with a real Git merge, and opens a pull request
with a compatibility report. Nothing is merged without passing the Windows
tests and a review. [docs/UPSTREAM-SYNC.md](docs/UPSTREAM-SYNC.md) ·
[tracking file](.github/upstream-sync.json).

## Releases

[docs/RELEASE-PROCESS.md](docs/RELEASE-PROCESS.md) · [release notes](RELEASE-NOTES.md) ·
[troubleshooting](docs/TROUBLESHOOTING.md)

## License and attribution

AIOStreams is © Viren070 and the AIOStreams contributors, licensed
**AGPL-3.0-only** ([LICENSE](LICENSE)). This distribution's changes are under
the same license. Each release ships its complete corresponding source, and
the app can download its own source from Settings → Local server. Bundled
third-party components (Node.js, mpv, FFmpeg, Rust crates, npm packages) and
their notices: [docs/embedded-third-party.md](docs/embedded-third-party.md).

Upstream: [github.com/Viren070/AIOStreams](https://github.com/Viren070/AIOStreams) ·
[upstream README](https://github.com/Viren070/AIOStreams#readme) ·
[aiostreams.org](https://aiostreams.org) · [support Viren070](https://github.com/sponsors/Viren070)
