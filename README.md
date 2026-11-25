<h1 align="center">AIOStreams for Windows (integrated build)</h1>

<p align="center">
  <strong>The AIOStreams desktop app with its own private AIOStreams server, plus AIOMetadata, built in. One Windows install, no Docker, no separate server.</strong>
</p>

<p align="center">
  <a href="https://github.com/AzizKamboh/aiostreams-desktop/releases/latest"><img src="https://img.shields.io/github/v/release/AzizKamboh/aiostreams-desktop?style=for-the-badge&logo=github&label=integrated%20release" alt="Latest integrated release"></a>
  <a href="https://github.com/AzizKamboh/aiostreams-desktop/actions/workflows/embedded-desktop.yml"><img src="https://img.shields.io/github/actions/workflow/status/AzizKamboh/aiostreams-desktop/embedded-desktop.yml?branch=main&style=for-the-badge&logo=windows&label=windows%20build" alt="Windows build"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/AzizKamboh/aiostreams-desktop?style=for-the-badge" alt="License: AGPL-3.0"></a>
</p>

> [!IMPORTANT]
> **Unofficial.** This is an independent Windows distribution of
> [**AIOStreams**](https://github.com/Viren070/AIOStreams), created by
> **[Viren070](https://github.com/Viren070) and the AIOStreams contributors**,
> and it bundles [**AIOMetadata**](https://github.com/cedya77/aiometadata) by
> **[cedya77](https://github.com/cedya77)**. Neither project made, endorses or
> supports this build. Report problems with it
> [here](https://github.com/AzizKamboh/aiostreams-desktop/issues), not upstream.
> For AIOStreams itself, go to [aiostreams.org](https://aiostreams.org) and the
> [upstream repository](https://github.com/Viren070/AIOStreams).

## What it is

Upstream AIOStreams is a self-hosted server (usually run with Docker) that
gathers your Stremio addons, debrid services and Usenet into one filtered,
sorted list, with apps to browse and play it. This build **combines the
upstream server and the upstream Windows desktop client into one
application**: the app starts its own private AIOStreams server on your PC,
signs itself in, and plays through mpv. It also runs **AIOMetadata**, the
metadata and catalog addon, beside it. Every streaming, provider, addon,
browsing and dashboard feature is the upstream projects' own code, unchanged
in function.

The integrated app has its own version number. Each version's
[release notes](RELEASE-NOTES.md) list what it was built from, and Settings →
Local server shows the app, upstream desktop client and upstream server
versions.

## Download

From the [latest release](https://github.com/AzizKamboh/aiostreams-desktop/releases/latest):

| File | Use |
| --- | --- |
| `aiostreams-integrated-win-x64-Setup.exe` | Installer (recommended). Per-user, no administrator rights, installs WebView2 if missing, adds **AIOStreams Integrated** shortcuts to the desktop and Start menu, named apart from upstream's own desktop client so both can be installed. |
| `aiostreams-integrated-win-x64-Portable.zip` | Portable copy. Needs the WebView2 runtime (present on Windows 11 and updated Windows 10). |
| `aiostreams-integrated-source.tar.gz` | Complete corresponding source (AGPL-3.0). |
| `SHA256SUMS.txt` | Checksums of every file. |

Windows 10/11 x64. Builds are **unsigned**, so SmartScreen may warn on first
run ("More info" → "Run anyway"). Each file has a
[build provenance attestation](docs/RELEASE-PROCESS.md#verifying-a-download):
`gh attestation verify <file> -R AzizKamboh/aiostreams-desktop`.

## Features

- Everything in the upstream **desktop client**: the browsing interface, the
  native mpv player (hardware decoding, audio/subtitle tracks, seeking,
  fullscreen, picture-in-picture), downloads, Discord presence (off by default).
- Everything in the upstream **server**: addons, debrid and Usenet providers,
  indexers, filtering, sorting, formatting, the AIOStreams Dashboard and the
  configuration page, running locally and opened inside the app.
- **AIOMetadata, built in**: rich catalogs and metadata from TMDB, TVDB,
  MyAnimeList, AniList and more, running privately on your PC with the Redis 8
  it needs. Configure it in your browser, add it to AIOStreams as a custom
  addon ([guide](docs/AIOMETADATA.md)).
- **Continue watching across devices** through a tracker such as Simkl,
  via AIOMetadata (off by default; [how](docs/AIOMETADATA.md#continue-watching-across-devices)).
- **First-run setup** for the AIOStreams account (upstream's
  `AIOSTREAMS_AUTH`, needed for built-in Usenet) and AIOMetadata's admin key,
  both kept encrypted for your Windows user.
- **Remote mode**: switch to a remote AIOStreams or Jellyfin server at any
  time, and back.
- **Automatic updates** of the whole app from this repository.

## How it works

```
aiostreams-desktop.exe (Rust, WebView2, libmpv)
 ├─ node.exe + the upstream AIOStreams server, on 127.0.0.1 (free port)
 │    data: %LOCALAPPDATA%\AIOStreams Integrated\backend (SQLite, cache)
 ├─ Redis 8 + node.exe + AIOMetadata, on 127.0.0.1:3232
 │    data: %LOCALAPPDATA%\AIOStreams Integrated\aiometadata
 ├─ loads the upstream web client from the AIOStreams server, with a private per-launch token
 └─ plays streams in mpv; stops every server when the app closes (Job Objects as backstop)
```

Nothing listens beyond this PC. The AIOStreams server checks Host and Origin
and requires a per-launch capability; Redis requires a password that changes
at every start. The server key, accounts, saved sign-ins and the AIOMetadata
admin key are encrypted with Windows DPAPI. Details:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Install and first run

1. Run `aiostreams-integrated-win-x64-Setup.exe`. It installs for your Windows
   user and adds **AIOStreams Integrated** shortcuts on the desktop and in the Start menu.
2. The app starts its local servers (the first start can take a few minutes
   while upstream data downloads) and asks you to create an **AIOStreams
   account**, the equivalent of `AIOSTREAMS_AUTH`. Skip it if you do not use
   built-in Usenet.
3. It then asks for **AIOMetadata's admin key** (Generate makes one). It opens
   AIOMetadata's dashboard; skipping it leaves that dashboard closed.
4. Use **AIOStreams Configuration** and **AIOStreams Dashboard** in the
   sidebar (also Ctrl+Shift+, and Ctrl+,) to set up providers, addons and
   streams. **Home** in their sidebars, or Escape, returns to the library.
5. Optional: Settings → Local server → **AIOMetadata** → **Configure
   AIOMetadata**, then add the manifest URL it gives you as a Custom addon in
   your AIOStreams configuration.

The full guide, including built-in Usenet: [README-INTEGRATED.md](README-INTEGRATED.md).

## Updates

The app keeps itself up to date from **this repository's releases only**,
never from upstream's separate desktop-only app, which would remove the
built-in servers.

- It checks shortly after starting and every six hours, downloads in the
  background and verifies the package.
- The update installs **when you close the app**, or immediately with
  **Install and restart** in Settings → Updates. It never restarts while
  something is playing.
- Channels: **Stable** (default) and **Preview** (new upstream releases about
  three days earlier, same tests). Your data, accounts, keys and settings are
  kept.
- 0.2.x has no updater: install a current release once by running its Setup
  over the old install.

Details, recovery and rollback: [docs/AUTO-UPDATE.md](docs/AUTO-UPDATE.md).

## Local and remote server

Settings → **Local server** → *Connection* switches between the built-in
server and upstream's remote-server picker (any AIOStreams or Jellyfin
server). The local servers keep running in the background until you exit, so
switching back is instant. Remote users are never asked to create a local
account.

## Supported platforms

Windows 10 and 11, x64. Other platforms are not built by this project; use
[upstream's apps](https://aiostreams.org/download) and Docker server there.

## Known limitations

- Unsigned builds (SmartScreen warning).
- Upstream's Linux FUSE mount and Jellyfin HLS/transcoding endpoints are not
  available; direct play is.
- Account passwords and keys reach the local servers as environment
  variables: DPAPI protects them from other Windows users and other PCs, not
  from malware running as you.
- Automated tests use fixtures; real debrid, Usenet, addon and tracker
  accounts are not tested in CI ([validation report](docs/embedded-desktop/VALIDATION.md)).
- Going back to an older version is not automatic and may be unsafe after a
  database migration ([rollback](docs/AUTO-UPDATE.md#rollback-and-recovery)).

## Security and privacy

No telemetry is added; tracker playback reporting and Discord presence are
off by default. Providers, addons and metadata sources receive the requests
their features need, as in upstream. Relayed provider content is sandboxed
from the app, only the app's own page may use the native player bridge
(AIOMetadata's pages open in your browser), and logs are redacted. Updates
come from this repository's feeds only and are checked for package identity
and checksums. Report vulnerabilities privately: [SECURITY.md](.github/SECURITY.md).

## Upstream sync and releases

Releases follow upstream automatically:

1. A daily workflow detects new stable **AIOStreams** releases (merged with a
   real Git merge) and new **AIOMetadata** releases (a version pin), and opens
   a pull request for each.
2. Once every check passes, including the real Windows build with its
   installer, playback and update tests, the pull request merges itself.
   Upstream merges with conflicts, and any failure, wait for a person.
3. The result is published as a **Preview**, and promoted to **Stable** after
   three days unless an issue labelled `release-blocker` is open.

[docs/UPSTREAM-SYNC.md](docs/UPSTREAM-SYNC.md) · [docs/RELEASE-PROCESS.md](docs/RELEASE-PROCESS.md) ·
[release notes](RELEASE-NOTES.md) · [troubleshooting](docs/TROUBLESHOOTING.md) ·
[tracking file](.github/upstream-sync.json)

## Build from source

The Windows package is built on native Windows x64 with Node 24, pnpm 11,
Rust, .NET 9 (for Velopack's `vpk`), git and MSYS2 (for ffprobe and Redis):

```powershell
bash scripts/desktop/build-ffprobe.sh                 # in MSYS2 MINGW64
MSYSTEM=MSYS bash scripts/desktop/build-redis.sh      # in MSYS2 (MSYS environment)
./scripts/desktop/package-windows.ps1 -Version 0.4.1-dev.1
./scripts/desktop/test-windows.ps1                    # installer, playback, upgrade and update tests
```

Pinned runtimes, payload layout and options: [docs/embedded-windows-build.md](docs/embedded-windows-build.md);
AIOMetadata and Redis: [docs/AIOMETADATA.md](docs/AIOMETADATA.md#building).
Server and web development follow upstream (`pnpm install`, `pnpm build`, `pnpm test`).

## Contributing

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md). Changes to AIOStreams or
AIOMetadata themselves belong upstream
([AIOStreams](https://github.com/Viren070/AIOStreams),
[AIOMetadata](https://github.com/cedya77/aiometadata)); this repository takes
integration, packaging, update and Windows-specific changes, and keeps
upstream files as close to upstream as possible
([where the integration touches upstream](docs/embedded-desktop/UPSTREAM-HOOKS.md)).

## License and attribution

AIOStreams is © Viren070 and the AIOStreams contributors, licensed
**AGPL-3.0-only** ([LICENSE](LICENSE)). This distribution's changes are under
the same license. AIOMetadata is © cedya77 and the AIOMetadata contributors
(AGPL-3.0-or-later core, FSL-1.1-ALv2 feature modules); "AIOMetadata" is
cedya77's trademark. Redis 8 is used under AGPLv3. Each release ships its
complete corresponding source, including AIOMetadata's and Redis's, and the app
can download its own source from Settings → Local server. Bundled third-party
components and their notices: [docs/embedded-third-party.md](docs/embedded-third-party.md).

Upstream: [github.com/Viren070/AIOStreams](https://github.com/Viren070/AIOStreams) ·
[aiostreams.org](https://aiostreams.org) · [support Viren070](https://github.com/sponsors/Viren070) ·
[github.com/cedya77/aiometadata](https://github.com/cedya77/aiometadata)
