# AIOStreams Integrated release notes

## 0.2.0 — stability and security

Security review of the integration code. Upgrades 0.1.x in place; all data,
keys, accounts and settings are kept.

- **Untrusted content can no longer act as the app.** Responses that relay
  addon, provider or indexer content (proxy, streams, WebDAV, builtins,
  Jellyfin and Stremio APIs) are served with `Content-Security-Policy:
  sandbox`, which a relayed provider header cannot remove. Opened as a page,
  such content gets an opaque origin: no session cookie, no API access.
- **Only the app's own page may use the native bridge** (player, downloads,
  accounts). Previously any page on the local server's origin could.
  Backend state, saved client credentials and player events are only sent to
  the app's own pages.
- Providers can no longer set cookies on the private origin through the proxy.
- Every local-server response sends `X-Content-Type-Options: nosniff`.
- Malformed request URLs are rejected instead of raising a server error.

Known limits, unchanged: account passwords and the server key reach the local
server as environment variables, readable by other programs running as the
same Windows user; DPAPI protects data from other users and other computers,
not from malware running as you.

## 0.1.1

Adds built-in Usenet streaming support and native navigation. Upgrades
0.1.0 test builds in place; all data, keys and settings are kept.

- **Built-in AIOStreams Usenet streaming now works.** A first-run screen creates
  your AIOStreams account (username, password, permissions), or accepts
  `AIOSTREAMS_AUTH` / `AIOSTREAMS_AUTH_PERMISSIONS` exactly as in a Docker
  `.env`. The account is stored with DPAPI, applied at every server start,
  checked against the built-in Usenet service, and manageable later in
  Diagnostics. Existing installs keep all data and are offered the setup once.
- **Native navigation replaces the floating Browse / Server settings /
  Diagnostics bar**, which covered the video. "Server dashboard" sits next to
  Settings in the library, on sign-in screens and in the player controls;
  the dashboard and configuration sidebars get "Browse" to return. The
  dashboard opens over the library, pausing playback and offering Resume, so
  the player, position, fullscreen and tracks are kept. Settings → Local server
  replaces Diagnostics. Shortcuts: Ctrl+, / Ctrl+Shift+, / Escape.
- Clearer startup screen with elapsed time, a note on slow first starts, and
  restart/logs/remote options after a failure.
- Smaller changes to upstream files: integration code moved into dedicated
  files, upstream SIGTERM/SIGINT handling restored, and stray formatting and
  byte-order-mark changes reverted. See
  `docs/embedded-desktop/UPSTREAM-HOOKS.md`.
- Account passwords are redacted from backend logs.

## 0.1.0 — first public release

The first public release of **AIOStreams Integrated**, an unofficial Windows x64
desktop app that runs its own private AIOStreams server. It is built from
upstream [AIOStreams](https://github.com/Viren070/AIOStreams) by Viren070,
tag `desktop-v0.24.0` (commit `76a5d6da6d1babf885c7f65a2e19bbd55401a26d`):
desktop client 0.24.0 and server 2.37.0. Licensed AGPL-3.0-only; the complete
corresponding source is attached to the release and downloadable from
Diagnostics.

### What's included

- The upstream desktop client (Rust/WebView2 shell, mpv player, browsing UI) and
  the upstream server and configuration dashboard, unchanged in function.
- A private local server: bundled Node, ffprobe and WebView2 runtime; bound to
  `127.0.0.1` on a free port; protected by a per-launch access token; shut down
  with the app. No Docker, Node or other install is needed.
- Server key and saved client settings protected with Windows DPAPI under your
  user profile (`%LOCALAPPDATA%` and `%APPDATA%\AIOStreams Integrated`).
- Server settings and Diagnostics views (status, restart, logs, source download,
  integrated and upstream versions), and a switch to use a remote AIOStreams or
  Jellyfin server instead.
- Analytics, tracker playback reporting and Discord presence off by default.

### Known limitations in 0.1.0

- **Built-in AIOStreams Usenet streaming does not work yet.** It needs an
  `AIOSTREAMS_AUTH` username:password with the *service* permission, and this
  release offers no way to create one (its internal account is not usable for
  that). Debrid services, WebDAV-based Usenet services (NzbDAV, AltMount,
  TorBox, etc.) and addons work through the normal configuration. A first-run
  account setup is planned for the next release.
- The Browse / Server settings / Diagnostics bar floats over video, including in
  fullscreen. Opening Server settings or Diagnostics stops playback.
- First start can take a minute or more while upstream data is downloaded; the
  startup screen shows a simple status message.
- The in-app updater is off. Upgrade by installing a newer release.
- Installers are unsigned. Windows x64 only. Upstream's Linux FUSE mount and
  Jellyfin HLS/transcoding endpoints are not available.
- Not tested against real paid provider accounts; see the validation report.

### Upgrading from test builds

Earlier CI test builds used the same package ID (`aiostreams-integrated`) and
version 0.1.0. Installing this release over one keeps your data. If Setup refuses
because the same version is already installed, uninstall the test build from
Windows Settings → Apps first: your data folders are not removed by uninstalling.
