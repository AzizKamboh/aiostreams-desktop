# AIOStreams Integrated release notes

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
