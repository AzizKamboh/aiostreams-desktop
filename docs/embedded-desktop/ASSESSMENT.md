# Embedded Windows desktop assessment

Assessed upstream `Viren070/AIOStreams` at
`76a5d6da6d1babf885c7f65a2e19bbd55401a26d` (server 2.37.0, desktop 0.24.0).
Both URLs supplied in the request refer to this monorepo. The actual desktop
client is `packages/desktop`; its browsing/player interface is `packages/web`.
The server configuration interface is the separate `packages/frontend` project.

## Reuse and architecture

Keep the Rust tao/wry desktop shell, Windows WebView2, libmpv rendering and bridge,
and the existing React browsing and player interface. Keep the Node server and
configuration dashboard. Add a desktop-owned Node process and a small local
management interface; do not replace the player or translate the server into a
different language.

The Dockerfile builds TypeScript and both frontends, installs production modules,
and copies resources/static files. Its final command is Node running
`packages/server/dist/server.js`. The health script uses `/api/v1/status`; the
server also has a database-backed `/api/v1/health` endpoint. There is no required
container service or Docker API. Node, compiled modules, and ffprobe can be
shipped directly. Linux mimalloc is an optional allocator optimization, and the
BusyBox health-check helpers are not needed in the Windows application.

Bundle Node 24, Windows native dependencies and ffprobe beside the native app.
Build the Windows dependencies on Windows, with the same Node major version and
architecture as the bundled runtime. Reuse upstream's pinned libmpv downloads
and Velopack installer/portable packaging. Keep all writable backend data outside
the installed application and retain the upstream database/configuration APIs.
The backend must bind to loopback, use the selected port consistently in BASE_URL
and INTERNAL_URL, and shut down when its owner closes. The native shell already
has a single-instance mechanism. A Windows Job Object provides process-tree
cleanup if graceful shutdown fails or the owner terminates.

## Windows dependencies and boundaries

| Dependency | Assessment |
| --- | --- |
| better-sqlite3, bcrypt, yencode | Native modules: compile/install for Windows and bundled Node ABI; do not copy Linux node_modules. |
| packages/crypto | Has MSVC configuration and an upstream node:crypto fallback. Preserve both. |
| ffprobe | Needed for media inspection/Usenet playback. Ship a Windows binary with its license and corresponding build/source information. |
| libmpv / FFmpeg / Vulkan | Already handled by upstream Windows fetch-libs script with pinned checksums and library licenses. |
| FUSE filesystem mount | Linux-oriented optional integration, disabled by default. Windows does not provide that kernel interface. Keep HTTP/streaming/WebDAV paths; do not introduce a driver or administrator requirement. |
| Redis/Postgres | Optional services. Use the existing SQLite/local cache defaults for embedded operation. |
| WebView2 | Desktop runtime dependency. Packaging must provision it when missing; no Node/Python/compiler should be needed by the end user. |

The upstream SQLite URI parser needs care with Windows absolute paths and URI
escaping. Running the server in its per-user data directory with
`DATABASE_URI=sqlite://./data/db.sqlite` avoids interpreting a drive letter as a
URL host and preserves spaces/non-English directory names.

## Existing supported capabilities

Server source contains addon aggregation/configuration, configuration profiles,
debrid providers, native Usenet streaming, Newznab/Torznab/indexer integrations,
filtering, sorting and formatting. The desktop reuses the web app's browsing,
Jellyfin-compatible API and mpv bridge, including track and subtitle controls.
Embedding these implementations preserves their code paths; it does not prove
every provider works without real accounts and endpoint testing.

Use supported configuration import/export and sign-in mechanisms rather than
inventing a second configuration schema. Keep remote-server selection available.
Disable the upstream automatic updater in this build: its hardcoded release feed
would replace the integrated application with the original client-only build.

## Licensing and privacy

The repository and Rust workspace declare **AGPL-3.0-only**. Preserve LICENSE,
copyright notices and upstream attribution. Distribute the complete modified
Corresponding Source, including build/installation scripts, alongside binaries;
provide the required source offer to users interacting remotely with modified
network software. Bundled Node, Rust crates, mpv, FFmpeg and npm modules have
additional notices/source requirements. Reuse upstream's cargo-about reports
and library licenses and include production npm notices. This assessment does
not substitute for an audit of the final shipped binary dependency set.

Protect the persistent server encryption secret with Windows DPAPI; do not put
secrets in command-line arguments. Keep logs under per-user data and redact
credentials. Existing upstream browser credential storage and third-party
provider access still need to be considered in release review. No new telemetry,
settings upload, or viewing-activity upload is part of the integration.

## Validation boundary

The implementation workspace is Linux. Server builds and process/API integration
tests can be run here. Native Windows packaging, DPAPI, Job Objects, WebView2,
installer upgrades and mpv video/audio output require a Windows runner or machine.
A workflow is an executable validation recipe, not evidence it was run. The
validation report records actual execution separately from pending scenarios.
