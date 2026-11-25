# AIOStreams (integrated Windows app) release notes

## 0.5.2

Automatic release after 0.5.1: upstream AIOStreams and AIOMetadata updates and fixes. The release page lists the upstream changes.

## 0.5.1

Upgrades 0.5.0 and earlier in place; data, keys, accounts and settings are
kept.

- **Smaller, faster updates.** The app no longer ships packages its server
  never loads (the documentation site's and build tools' dependencies, source
  maps, type declarations). They were about 600 MB and 30,000 files of the
  installed app, so downloading and installing an update now takes much less
  time. Nothing changes in how the app works.

## 0.5.0

Upgrades 0.4.0 and earlier in place; data, keys, accounts and settings are
kept. The release page lists the upstream AIOStreams and AIOMetadata versions
it was built from.

- **Installs beside upstream's desktop client.** Shortcuts and the Apps &
  Features entry are now named **AIOStreams Integrated**, so they no longer
  share the name "AIOStreams" with upstream's own desktop app; installing or
  removing one leaves the other's shortcuts alone. The two apps already kept
  separate data, settings and updates.
- **AIOMetadata in the sidebar.** A new **AIOMetadata** button in the left
  sidebar opens AIOMetadata's configuration page in your browser (once
  AIOMetadata is ready).
- **Tidier Settings.** Settings → Updates shows only the channel and the
  status, like upstream's own app (errors appear in the status; versions are
  in Settings → Local server). The **Download source code** link is gone from
  Settings → Local server; every release still ships the full source.
  "AIOStreams accounts" is now **AIOStreams AUTH**.
- **Watch progress syncs by default**, like upstream AIOStreams: what you
  play is sent to tracker addons (such as AIOMetadata with Simkl connected)
  unless you turn off Settings → Local server → Watch progress → **Sync
  watch progress with trackers**. If you turned it off, it stays off.
- **Playback keeps going while you tweak.** Opening the AIOStreams Dashboard
  or Configuration while something plays moves it to the mini player, which
  stays visible and usable over the dashboard, instead of pausing it.
- **The app opens once both servers have started.** The launch screen now
  waits for AIOMetadata as well as AIOStreams, so the library opens with
  AIOMetadata's catalogs instead of "No catalogs yet". If AIOMetadata's
  first start is slow, **Continue without waiting for AIOMetadata** appears
  under the logo; the library then reloads by itself once AIOMetadata is
  ready.
- **Fixed:** download buttons in the AIOStreams Dashboard (logs, settings
  export) did nothing in the app. The file now downloads.
- **Fixed:** the startup screen could receive no status text (found by the new
  type check).
- Behind the scenes: automatic Preview builds pass the Windows update test
  (it now follows the build's channel), a failed Preview is no longer rebuilt
  over and over, and a new check makes sure every text in the app is in its
  catalog (0.5.0-preview.1's predecessor, 0.4.1-preview.1, showed a few as
  short codes like `-aXLs4`).

## 0.4.0

Upgrades 0.3.0 and earlier in place; data, keys, accounts and settings are kept.
Built from upstream `desktop-v0.28.0` (server 2.38.1, desktop client 0.28.0).

- **AIOMetadata, built in.** The app now runs [AIOMetadata](https://github.com/cedya77/aiometadata)
  4.1.0 on your computer beside the AIOStreams server, with the Redis 8 it
  needs, private to this computer like the server. Configure it from
  Settings → Local server → AIOMetadata (it opens in your browser), then add
  the manifest URL it gives you to your AIOStreams configuration as a Custom
  addon. See docs/AIOMETADATA.md.
- **AIOMetadata admin key.** After the AIOStreams account, the first start asks
  for AIOMetadata's admin key (its `ADMIN_KEY`, which opens its dashboard);
  Generate makes one. It is kept protected for your Windows user. Existing
  installs are asked once.
- **Continue watching across devices.** Settings → Local server → Watch
  progress → **Sync watch progress with trackers** sends what you watch to
  tracker addons, such as AIOMetadata with Simkl connected, so your other
  devices see it. Off by default.
- **AIOStreams Configuration** now sits beside **AIOStreams Dashboard** in the
  sidebar and menus. Both buttons left the player controls.
- **Home** in the configuration page's sidebar (new layout too) and the
  dashboard's now returns to the library's home page.
- **Desktop shortcut.** Setup now creates a desktop shortcut as well as the
  Start-menu one.
- **Fixed:** opening Settings showed "appBridge is not defined" since the
  desktop-v0.27.0 update.
- Behind the scenes: new AIOStreams and AIOMetadata releases are synced daily
  and, once every check passes, published as Preview releases automatically,
  then promoted to Stable after three days (docs/RELEASE-PROCESS.md).

## 0.3.0

Upgrades 0.2.2 and earlier in place; data, keys, accounts and settings are kept.
Built from upstream `desktop-v0.24.0` (server 2.37.0, desktop client 0.24.0).

- **Automatic updates.** The app now updates itself from this repository's
  releases: it checks shortly after starting and every six hours, downloads
  in the background, and installs when you close the app or choose
  **Install and restart**. It never restarts while something plays. Updates
  come only from this project's own feed, never from upstream's client-only
  app, and an offer of any other package is refused. Settings → Updates shows
  the version, channel, progress, last check and any error, with Check now,
  Retry and release notes. Choose **Preview** there for earlier, less tested
  builds; Stable stays the default. Because 0.2.2 had no updater, install
  0.3.0 once by running its Setup; later versions arrive automatically.
- Portable copies update the same way (Velopack supports portable updates);
  this is covered by the Windows CI update test.
- Release downloads now carry a build provenance attestation
  (`gh attestation verify <file> -R AzizKamboh/aiostreams-desktop`) besides
  `SHA256SUMS.txt`.
- Behind the scenes: upstream AIOStreams releases are now detected daily and
  prepared as reviewed pull requests; see docs/UPSTREAM-SYNC.md.

## 0.2.2

Upgrades 0.2.1 and earlier in place; data, keys, accounts and settings are kept.

- **Much smaller download.** The app now uses the WebView2 that Windows keeps
  up to date instead of shipping its own pinned copy, so the browser engine
  gets security fixes without waiting for an app release. Setup installs
  WebView2 if a PC lacks it. The portable ZIP needs WebView2 to be present
  (it is on Windows 11 and on updated Windows 10).
- Security: only the exact configuration and web-client pages are exempt from
  the sandbox for relayed content; look-alike paths such as a relayed file
  named `configure` are now sandboxed too.
- If the local server stops unexpectedly after running for a minute or more,
  the app restarts it once automatically instead of showing the failure screen.
- If Windows cannot unlock the saved client settings, the failure screen now
  offers to start with empty client settings. The unreadable file is kept;
  server data, configurations and accounts are untouched.

## 0.2.1 — first public release

Upgrades 0.1.0 and 0.2.0 in place; data, keys, accounts and settings are kept.

- The app is now called **AIOStreams** (window, Start menu, Windows Apps
  list). Data folders and the install identity are unchanged, so updates keep
  all data and settings.
- **Much faster starts.** The local server no longer waits for its online
  datasets (anime database, SeaDex, scene and ID mappings, Prowlarr indexer
  list) before opening; they refresh in the background, using the previous
  run's data meanwhile. On the very first run, anime matching fills in once
  the download finishes. Node also keeps a compile cache between starts.
- Startup keeps the AIOStreams launch splash, with the server's current stage
  underneath instead of a separate screen and timer. A hint appears only when
  a first start runs long; failures show restart, logs and remote options.
- "Server dashboard" is now **AIOStreams Dashboard**, and the dashboard's
  return entry is **Home**.
- The first-run account is always the administrator; the permission selector
  stays in Settings → Local server for extra accounts.

## 0.2.0 (draft only; everything below ships in 0.2.1)

Usenet accounts, native navigation and a security review.

Upgrades 0.1.0 in place; all data, keys and settings are kept.

### New
- **Built-in AIOStreams Usenet streaming now works.** A first-run screen creates
  your AIOStreams account (username, password, permissions), or accepts
  `AIOSTREAMS_AUTH` / `AIOSTREAMS_AUTH_PERMISSIONS` exactly as in a Docker
  `.env`. The account is stored with DPAPI, applied at every server start,
  checked against the built-in Usenet service, and manageable later in
  Settings → Local server. Existing installs keep all data and are offered the setup once.
- **Native navigation replaces the floating Browse / Server settings /
  Diagnostics bar**, which covered the video. "AIOStreams Dashboard" sits next to
  Settings in the library, on sign-in screens and in the player controls;
  the dashboard and configuration sidebars get "Home" to return. The
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

### Security
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

## 0.1.0 — test builds (not published as a release)

The first builds of **AIOStreams Integrated**, an unofficial Windows x64
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
