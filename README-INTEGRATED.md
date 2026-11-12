# AIOStreams Integrated for Windows

This variant combines the existing AIOStreams server and Windows desktop client
from the same upstream monorepo. It keeps the Rust/WebView2 shell, mpv player,
browsing interface, server configuration dashboard, and existing provider logic.
The desktop owns a private Node server process; Docker is not used.

**Release status:** implementation and Linux validation are available. See
`docs/embedded-desktop/VALIDATION.md` for the exact results. A Windows-target
executable was cross-built; that is not an installed or Windows-playback-tested
release. The Windows installer/portable workflow still needs to run on Windows.

## Using a Windows package

After building and validating a package, run its Setup.exe as your normal Windows
user. It installs one AIOStreams Integrated Start-menu shortcut. The portable
archive is an alternative; both variants keep data in your Windows profile.
The complete package bundles Node, WebView2, mpv and ffprobe. You do not need to
install Docker, Node.js, Python, or a compiler to use that package.

On first launch the app starts the local server and displays the upstream setup
interface. Use **Server settings** to configure addons, debrid/Usenet services,
filters and profiles, or the upstream import/existing-configuration mechanisms.
Use **Browse** to sign into your configuration and use the existing browsing and
player features. **Diagnostics** provides backend status, restart, logs and a
source-code download. The existing player retains subtitles, audio tracks and
playback controls; external services still need your accounts and configuration.

Choose **Remote AIOStreams or Jellyfin server** in Diagnostics to use upstream's
remote-server picker. That UI is served from the bundled client so a local backend
failure does not interrupt its native-player bridge. The local backend remains
owned in the background until app exit. Return to the embedded option to use the
local configuration again.

## Build and development

See `docs/embedded-windows-build.md` for the native Windows toolchain, pinned
runtime downloads, full payload layout and packaging commands. The build entry
points are:

```sh
# MSYS2 MINGW64, in the repository root
bash scripts/desktop/build-ffprobe.sh
```

```powershell
# Native Windows x64, PowerShell 7
./scripts/desktop/package-windows.ps1 -Version 0.1.0
```

`.github/workflows/embedded-desktop.yml` runs the Windows build and tests and
uploads the installer, portable archive, source and hashes. It does not publish
to upstream or another release feed. Installers are unsigned by default.

For server development use upstream's Node 24/pnpm instructions. After installing
dependencies, `pnpm run build` builds the real server and both interfaces;
`pnpm -F web build:standalone` builds the desktop browsing interface. The native
development overrides `AIOSTREAMS_DESKTOP_NODE`, `AIOSTREAMS_DESKTOP_SERVER`, and
`AIOSTREAMS_DESKTOP_WEB_DIR` accept absolute paths to a runtime, compiled server
entry point and standalone interface. Production resolves these from the package.
The desktop framework and player build instructions remain in
`packages/desktop/README.md`.

Run the backend integration suite after building:

```sh
node scripts/desktop/smoke.mjs --ffprobe /path/to/ffprobe
# Optional full audio/video decode check:
node scripts/desktop/smoke.mjs --ffprobe /path/to/ffprobe --ffmpeg /path/to/ffmpeg
```

## Data, upgrades and security

Windows paths are separate from installed application files:

| Data | Location |
| --- | --- |
| Backend working directory, SQLite and cache | `%LOCALAPPDATA%\AIOStreams Integrated\backend` |
| SQLite database | `backend\data\db.sqlite` beneath that data directory |
| Protected server key and browser snapshot | Protected files in the backend directory |
| Native diagnostics and WebView profile | `%LOCALAPPDATA%\AIOStreams Integrated` |
| Player settings and native preferences | `%APPDATA%\AIOStreams Integrated` |

Keep both application-data directories when upgrading. Never delete the backend
key to repair startup: existing encrypted configuration depends on it. Back up
the directories together, and use upstream's supported configuration exports
to move to a different Windows account or computer. DPAPI-protected data is tied
to the original Windows user. Portable packages also use these per-user paths.

The backend binds to `127.0.0.1`, selects an available port, waits for its own
readiness event and health check, and requires a private capability. URLs and
saved client/download addresses follow the selected port. Native playback uses
a credential attached only to owned local URLs; external redirects do not get
that credential. A Windows Job Object contains the process tree and stdin permits
graceful shutdown. The upstream single-instance mechanism prevents duplicate apps.

The server key and stable client snapshot use Windows DPAPI. Active upstream
browser localStorage copies of client credentials still exist in the private
WebView profile. This is not complete protection against malicious software
running as the same Windows user. Native backend logs keep classified diagnostics
instead of raw potentially sensitive output; upstream log redaction is also
enforced in embedded mode. No new telemetry or credential/viewing-data upload is
added. Providers, configured remote servers, and upstream metadata/catalog sources
make the network requests required by their existing functions.

The upstream updater is disabled because its client-only release would remove
the integration. Install a newer integrated package with the same package ID to
upgrade. Windows can associate the upstream `aiostreams:` protocol with one app
at a time; the installer retains upstream's protocol registration behavior.

## Troubleshooting and boundaries

- **Missing bundled runtime/server:** reinstall the complete integrated package;
  do not copy only the desktop executable.
- **Startup fails:** inspect Diagnostics/Open logs. The first startup may download
  upstream metadata; the supervisor allows four minutes. Retry after resolving
  the reported database, port, disk or dependency problem.
- **Cannot unlock protected data:** use the original Windows user or a supported
  configuration export. The app does not silently replace a missing encryption key.
- **Provider failures:** check upstream configuration and service availability.
  Automated fixture tests do not certify account-dependent integrations.
- **FUSE:** upstream's optional Linux filesystem mounting is unavailable on Windows.
  Existing HTTP/Usenet/WebDAV paths remain the intended alternatives.
- **HLS/transcoding:** upstream's Jellyfin transcoding/HLS endpoints return 501.
  External direct-play sources remain supported. Its raw proxy does not rewrite
  relative HLS playlist resources; this integration does not add a transcoder.

Read `docs/embedded-desktop/ASSESSMENT.md` for the repository assessment and
`docs/embedded-third-party.md` for attribution. The application remains
AGPL-3.0-only. Distribute its complete modified source and required dependency
notices/source alongside binaries. This is an unofficial integrated variant.
