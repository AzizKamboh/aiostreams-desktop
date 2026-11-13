# Troubleshooting AIOStreams Integrated

For AIOStreams configuration itself (addons, debrid, Usenet services) see
[aiostreams.org](https://aiostreams.org/troubleshooting). Below are problems
specific to the integrated Windows app. Diagnostics: Settings → Local server
→ **Read diagnostics** / **Open logs** (logs are in
`%LOCALAPPDATA%\AIOStreams Integrated\logs`; remove secrets before sharing).

## Installation

- **SmartScreen warns**: builds are unsigned. Check the file with
  `SHA256SUMS.txt` and `gh attestation verify` ([RELEASE-PROCESS.md](RELEASE-PROCESS.md#verifying-a-download)),
  then "More info" → "Run anyway".
- **Blank or missing window (portable)**: install the
  [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/),
  or use Setup, which installs it.
- **"Missing bundled runtime/server"**: reinstall the complete package; do not
  copy only `aiostreams-desktop.exe`.

## The local server does not start

- The first start downloads upstream datasets and can take minutes; later
  starts are fast. The startup screen shows the current stage.
- Use **Restart** on the failure screen, then **Open logs**. Common causes:
  no disk space, antivirus blocking `node.exe`, a damaged install (run Setup
  again — data is kept).
- **Cannot unlock protected data**: DPAPI data only opens for the Windows user
  (and PC) that created it. Sign in as that user, or move with upstream's
  configuration export. The app never replaces a missing server key, because
  encrypted configurations depend on it — **do not delete
  `server-key.protected`**.
- **Saved client settings cannot be unlocked**: the failure screen offers to
  start with empty client settings; the unreadable file is kept.
- To use the app meanwhile, choose **Use a remote server**.

## Updates

Settings → Updates shows the channel, status, last check and last error.

| Message | Meaning and fix |
| --- | --- |
| "does not update itself (not installed or packed by Velopack…)" | A development build or a copy run from outside its install. Install with Setup. |
| "… channel 'win-x64-nightly' has no integrated feed" | Not an integrated package. Install the integrated Setup. |
| 404 | The feed has not been published yet for this channel; nothing to do. |
| 403 / 429 / rate limit | GitHub limits anonymous requests; the app waits an hour. |
| "refused: the feed offers package …" | The feed offered a different app. Nothing was downloaded. Please [report it](https://github.com/AzizKamboh/aiostreams-desktop/issues/new?template=2-update.yml). |
| "Checksum did not match" | The download was corrupted and discarded. Use Retry. |
| "not enough disk space" | Free the amount shown, then Retry. |
| "the download failed several times" | Automatic retries stopped for this version; use Retry. |

- **Update ready but not installing**: it installs when you close the app window,
  or use **Install and restart**.
- **App did not come back after Install and restart**: start it from the
  Start menu; Velopack's own log is in the install folder,
  `%LOCALAPPDATA%\aiostreams-integrated`.
- **Something broke after an update**: see
  [AUTO-UPDATE.md → Rollback](AUTO-UPDATE.md#rollback-and-recovery). Do not
  install an older version over a newer database without your backup.
- **Portable copy on a read-only drive**: updates cannot be written; extract a
  newer portable ZIP instead.

## Playback

- Try the same title in upstream's own desktop app or a browser player to see
  whether the source or the integration is at fault.
- mpv options: Settings → mpv → Open folder (`%APPDATA%\AIOStreams Integrated\mpv`).
- Built-in Usenet streaming needs an AIOStreams account with the *service*
  permission and its `username:password` pasted into the AIOStreams service
  of your configuration ([README-INTEGRATED.md](../README-INTEGRATED.md#aiostreams-account-and-built-in-usenet)).

## Reporting

Use the [issue forms](https://github.com/AzizKamboh/aiostreams-desktop/issues/new/choose)
(installation, update, startup, playback, upstream regression). Include the
integrated version and diagnostics with secrets removed.
