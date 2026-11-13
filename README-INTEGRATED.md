# AIOStreams for Windows, with its own server

The app is called **AIOStreams**. It is an unofficial build that combines the existing AIOStreams server and Windows desktop client
from the same upstream monorepo. It keeps the Rust/WebView2 shell, mpv player,
browsing interface, server configuration dashboard, and existing provider logic.
The desktop owns a private Node server process; Docker is not used.

**Version 0.2.0** is the first public release of this unofficial integrated
variant, built from upstream `desktop-v0.24.0` (commit `76a5d6da`; desktop
client 0.24.0, server 2.37.0). Download it from this repository's
[Releases](https://github.com/AzizKamboh/aiostreams-desktop/releases): run
`aiostreams-integrated-win-x64-Setup.exe`, or extract the portable ZIP. Packages
are unsigned, so Windows SmartScreen may warn on first run. Read
[the release notes](RELEASE-NOTES.md) for known limitations, and
[the validation report](docs/embedded-desktop/VALIDATION.md) for what was tested.

The [Integrated Windows desktop workflow](https://github.com/AzizKamboh/aiostreams-desktop/actions/workflows/embedded-desktop.yml)
builds and tests every push to `main`. Run it manually with **draft_release**
ticked to turn a tested build into a draft release (see *Making a release*).

## Using a Windows package

After building and validating a package, run its Setup.exe as your normal Windows
user. It installs one AIOStreams Integrated Start-menu shortcut. The portable
archive is an alternative; both variants keep data in your Windows profile.
The complete package bundles Node, WebView2, mpv and ffprobe. You do not need to
install Docker, Node.js, Python, or a compiler to use that package.

On first launch the app starts the local server, asks you to create an
AIOStreams account (below), then shows the library. Everything else is in the
upstream interfaces, with native entries added where they belong:

| Where | Entry |
| --- | --- |
| Library sidebar / menu (next to Settings) | **AIOStreams Dashboard** |
| Sign-in screens | **Create or edit a configuration**, **AIOStreams Dashboard** |
| Player controls (hide with the controls) | **AIOStreams Dashboard** button |
| Settings → **Local server** | status, versions, accounts, restart, logs, diagnostics, source download, local/remote switch |
| Dashboard and configuration sidebars | **Home** returns to the app |

The dashboard opens over the library, so a playing title keeps its player:
playback pauses, and closing the dashboard offers **Resume**. Keyboard:
**Ctrl+,** opens the AIOStreams Dashboard, **Ctrl+Shift+,** the configuration, and
**Escape** returns to the library. Shortcuts never fire while you type in a
field. Restarting the backend or switching servers asks first while something
plays.

### AIOStreams account and built-in Usenet

On first launch the app asks you to create an **AIOStreams account**. This is
what a Docker install sets with `AIOSTREAMS_AUTH` and
`AIOSTREAMS_AUTH_PERMISSIONS`; the **Environment variables** tab accepts those
exact values if you want to copy them from an existing install. The account is
stored with Windows DPAPI and passed to the local server as those two
variables at every start. The app then checks it with the same test the
built-in Usenet service uses before streaming, and shows the result.

To stream from your Usenet providers:

1. Add the NNTP providers in **Usenet providers** (linked from the setup screen;
   also Server settings → dashboard → Usenet → Providers).
2. In your configuration, add the **AIOStreams** service (built-in Usenet) and
   paste your `username:password` as its AIOStreams auth token.

The AIOStreams account is not your Usenet provider login, and it is separate
from a configuration's password. Change accounts later in **Settings → Local
server → AIOStreams accounts**. Changing a password or removing an account stops
configurations that use the old `username:password` until you paste the new
one; unchanged accounts keep working. You can skip the setup; Debrid and
WebDAV-based services do not need it, and remote-server users are never asked.

Choose **Remote AIOStreams or Jellyfin server** in Settings → Local server to use upstream's
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
`pnpm -F @aiostreams/web build:standalone` builds the desktop browsing interface. The native
development overrides `AIOSTREAMS_DESKTOP_NODE`, `AIOSTREAMS_DESKTOP_SERVER`, and
`AIOSTREAMS_DESKTOP_WEB_DIR` accept absolute paths to a runtime, compiled server
entry point and standalone interface. Production resolves these from the package.
The desktop framework and player build instructions remain in
`packages/desktop/README.md`.

`AIOSTREAMS_DESKTOP_DATA_DIR` can select an absolute, isolated test profile;
normal launches use Windows application-data directories. The native Windows
test (`node scripts/desktop/native-smoke.mjs <staged-payload>`) uses this to
exercise real WebView2/mpv playback without touching an existing user's settings.

Run the backend integration suite after building:

```sh
node scripts/desktop/smoke.mjs --ffprobe /path/to/ffprobe
# Optional full audio/video decode check:
node scripts/desktop/smoke.mjs --ffprobe /path/to/ffprobe --ffmpeg /path/to/ffmpeg
```

## Making a release

1. Push the reviewed commit to `main` and wait for **Integrated Windows desktop**
   to pass.
2. Actions → Integrated Windows desktop → **Run workflow** on `main`, set
   **version** (for example `0.1.0`) and tick **draft_release**. The run builds,
   re-runs every test, then creates a *draft* release `v<version>` with the
   installer, portable ZIP, source archive and `SHA256SUMS.txt`.
3. Download and test the draft's files, edit its notes, then click **Publish**.
   Nothing is published automatically.

Each new release must use a higher version than the last. The in-app updater is
off in 0.2.0, so users upgrade by running the newer Setup.exe; it upgrades the
existing install in place and keeps all data.

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
added. Playback-event reporting to tracker addons and Discord presence default
off; either can be enabled in the existing settings. Providers, configured remote
servers, and upstream metadata/catalog sources
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
