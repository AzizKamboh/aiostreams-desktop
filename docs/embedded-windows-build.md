# Building AIOStreams Integrated for Windows

The integrated build reuses the upstream Rust/WebView2/mpv desktop app and the
Node server. It packages its own Node, a fixed WebView2 runtime, libmpv, FFmpeg
DLLs, Vulkan loader and a minimal ffprobe. Users do not need Docker, Node,
Python, Rust, Visual Studio, or .NET installed. Build tools are only needed on
the build machine. The first packaging target is Windows x64.

## Build

Use a native Windows x64 machine with PowerShell 7, Git, 7-Zip, Visual Studio
2022 or later C++ build tools and Windows SDK, .NET SDK 9, Rust 1.99.1, Node
24.18.1, and pnpm 11.0.8. Install MSYS2 with its MINGW64 GCC, make, curl, tar
and zlib packages. The workflow `.github/workflows/embedded-desktop.yml`
installs these tools on a Windows runner and uploads artifacts without
publishing a release.

In an MSYS2 MINGW64 terminal, from the repository root:

```sh
bash scripts/desktop/build-ffprobe.sh
```

Then in PowerShell 7:

```powershell
./scripts/desktop/package-windows.ps1 -Version 0.3.0-dev.1
# Release builds also pass the channel, the published feed (for a delta) and
# the repository the app updates from:
./scripts/desktop/package-windows.ps1 -Version 0.3.0 -Channel stable `
  -FeedUrl https://github.com/AzizKamboh/aiostreams-desktop/releases/download/updates-stable/ `
  -UpdateRepository AzizKamboh/aiostreams-desktop
```

The script uses the repository's frozen pnpm and Cargo lockfiles, builds the
native addons on Windows for the bundled Node ABI, builds both server
frontends, runs Rust tests, stages a production-only backend, checks it with
the real-server smoke test, then invokes Velopack 1.2.158. Runtime download
versions and SHA-256 hashes are in `scripts/desktop/runtime-pins.json`; mpv and
Vulkan pins remain upstream's `packages/desktop/libs.pin`. The package is
reproducible from these source inputs; it is not claimed to be byte-for-byte
deterministic because Windows toolchains, signing and archives can encode
timestamps, and MSYS2 build packages receive updates.

Outputs are in `.embedded-releases/`: a per-user Setup.exe, a portable zip,
Velopack update packages (full, and delta when `-FeedUrl` is given) with the
channel's `releases.<channel>.json` feed, the corresponding modified
application source, `BUILD-INFO.json` and SHA-256 checksums. One
Start-menu shortcut is installed. Builds are unsigned unless the maintainer
adds code signing. Installer identity is `aiostreams-integrated`, separate
from upstream's desktop client. Upgrades must keep this identity and use an
increasing version. Stable packages use Velopack channel `win-x64`, preview
packages `win-x64-preview`. The app updates only from the repository given
by `-UpdateRepository` (the script refuses upstream's), never from upstream's
update feed; see [AUTO-UPDATE.md](AUTO-UPDATE.md).
No packaging command publishes artifacts or uploads user data.

`-SkipBuild` reuses already built files; it is for local iteration only.
`-SkipSmoke` explicitly omits the package smoke test; use neither switch for a
release. For standalone validation, use
`node scripts/desktop/smoke.mjs --app-root <backend/app> --node <backend/node.exe> --ffprobe <backend/bin/ffprobe.exe>`.
The workflow repeats the smoke test with Node/developer tools removed
from PATH, using absolute paths to bundled Node and ffprobe.

## Payload and data

```text
aiostreams-desktop.exe
web/                             bundled browsing UI
webview2/                        fixed Microsoft WebView2 runtime
backend/node.exe
backend/bin/ffprobe.exe
backend/app/packages/server/dist/
backend/app/packages/core/dist/
backend/app/packages/crypto/
backend/app/packages/frontend/dist/
backend/app/packages/web/dist/
backend/app/node_modules/         production dependencies; no junctions
backend/app/resources/
licenses/
source/                          modified application and ffprobe source
```

SQLite, configuration, credentials, WebView storage, caches and logs live in
the per-user `AIOStreams Integrated` application-data directories selected by
the native client, separate from installed application files. Portable
builds also use these per-user directories. Replacing the installed payload
does not intentionally replace user data. Back up the entire application
data directory before upgrading; the protected backend encryption key is
needed to read existing credentials.

The production dependency stage uses pnpm's hoisted linker and replaces
workspace junctions with package entry points targeting the retained
monorepo paths. It therefore survives zip extraction and does not depend on
the build machine, administrator privileges, or Windows Developer Mode.
The optional crypto acceleration addon retains upstream's Node crypto
fallback. Native SQLite, bcrypt, and yencode must load under bundled Node;
the smoke test fails packaging if the server cannot start.

## Windows-specific boundaries

FUSE mounting is Linux-only in upstream `@aiostreams/fsmux-fuse`. Its loader
reports this on Windows without preventing normal startup. Existing HTTP
streaming remains available; this package does not add a Windows filesystem
driver or emulate FUSE. External Usenet/debrid/indexer accounts and services
remain external and require the user's own configuration.

The fixed WebView2 runtime is pinned so a fresh install needs no separate
runtime download. It must be updated in future application releases to
receive browser security fixes. Windows 10/11's Universal CRT and OS
components are still required. Visual C++ CRT redistributable DLLs are
deployed app-locally. Do not substitute Linux-built `.node` files into the
Windows payload.

## Validation and release acceptance

The workflow defines native Windows builds and backend tests; a workflow
file is not evidence that those tests have run. Consult the accompanying
validation report for actual results. Before releasing, run this workflow
and test the resulting installer on a clean Windows account without Docker
or developer runtimes, including:

- First launch, configuration import, provider/addon setup, and restart.
- An actual authorized stream played through the retained mpv player,
  subtitles and audio-track selection.
- Occupied ports, backend crash/restart, repeated launches, and application
  termination with no surviving owned children.
- Installation and user paths with spaces and non-English characters.
- Installation of a second version over the first without data loss.
- Remote-server mode and returning to the embedded backend.

The automated smoke test verifies the real server, SQLite/config persistence,
authentication, addon aggregation, media bytes/ranges, and lifecycle behavior.
It does not prove that the Windows GUI, installer, GPU driver, or audio device
works. Do not describe those as tested without a native Windows run.

For startup failures, use Diagnostics and Open logs. A missing bundle file
requires rebuilding/reinstalling the complete package. A native addon load
failure normally means the payload was built for the wrong OS or Node ABI.
Keep backend data when reinstalling; deleting its key or database is not a
startup repair.

## Source and licensing

The full modified application source archive is included under `source/` and
uploaded beside installer artifacts. The server's source endpoint exposes
this local archive to authenticated users. Preserve it alongside binaries
when redistributing, and make it available to users interacting with a
modified network service under AGPL-3.0 section 13. See
`docs/embedded-third-party.md` for dependency notices and upstream source
locations. Review the notices before redistributing signed/public builds.
