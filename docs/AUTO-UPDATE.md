# Automatic updates

The integrated app updates itself — native client, bundled Node server,
web interfaces, mpv and every runtime together, as one tested package — from
**this repository's releases only**. It uses [Velopack](https://velopack.io),
which upstream's desktop app also uses, with the integrated package identity
`aiostreams-integrated`.

## How a release reaches an installed app

1. A published release is verified and its packages are uploaded to the feed
   release of its channel (`updates-stable` or `updates-preview`) by
   *Release publishing* ([RELEASE-PROCESS.md](RELEASE-PROCESS.md)).
2. The app reads
   `https://github.com/AzizKamboh/aiostreams-desktop/releases/download/updates-<channel>/releases.<velopack-channel>.json`
   45 seconds after starting, whenever the settings page loads (at most once a
   minute), on **Check for updates**, and every six hours. The repository is
   compiled into the app (`package-windows.ps1 -UpdateRepository`); the
   packaging script and the app both refuse `Viren070/AIOStreams`.
3. If the newest full package is newer than the installed version, the app
   checks — **before downloading** — that it is package `aiostreams-integrated`
   (and so are any deltas). Velopack itself does not check package identity;
   an offer of upstream's `aiostreams-desktop` or anything else is refused and
   reported. Older versions are never offered (no downgrades).
4. It checks there is enough free disk space, then downloads in the
   background — a small delta if the installed version is the previous one,
   otherwise the full package. Velopack verifies the SHA-256 from the feed
   before keeping the file; a corrupted download is discarded.
5. The update is now *ready*. Nothing restarts:
   - closing the app installs it (silently, after the app has shut down its
     local server normally), and the next start runs the new version;
   - **Install and restart** (Settings → Updates, or upstream's update
     notice) closes the app through the same normal shutdown, installs, and
     starts the new version. While something is playing the app asks first;
     upstream's update notice waits until playback ends.
6. Velopack replaces only the program folder
   (`%LOCALAPPDATA%\aiostreams-integrated\current`). User data lives
   elsewhere and is never touched.

## Channels

| | Stable | Preview |
| --- | --- | --- |
| Default | yes | no, chosen in Settings → Updates |
| Versions | `X.Y.Z` | `X.Y.Z-preview.N`, plus every stable release |
| Testing | full Windows CI | the same full Windows CI |
| Velopack channel | `win-x64` | `win-x64-preview` |

Settings → Updates → *Channel* switches. Upstream's setting is reused
(its "nightly" value means Preview here). Switching from Preview back to
Stable does **not** install an older version: the app stays on its version
until a newer stable release exists (a newer database may not open in an
older app). Copies with any other Velopack channel (for example a test
build) report updates as off.

## Failures

- Network errors, a missing feed (404), an unavailable server (5xx) or
  malformed metadata are shown under *Last error*; the app and playback carry
  on. Checks back off: 5, 10, 20, 40, 80, 160 minutes, then the normal six
  hours; GitHub rate limiting waits an hour.
- A version whose download fails four times is not retried automatically;
  **Retry** (or Check for updates) tries again.
- If the installer cannot start at exit, the current version stays installed
  and the downloaded package is retried at the next exit.
- If Velopack fails while installing, it keeps or restores the previous
  version; it never leaves a half-replaced program folder in use.

## Portable copies

The portable ZIP contains Velopack's `Update.exe` and a `.portable` marker,
and updates itself in place the same way, inside its own folder. Its user
data is in the same per-user folders as an installed copy (unchanged from
0.2.x). The Windows CI update test covers a portable copy updating itself.
If the portable folder is read-only (for example on some USB drives),
updates fail with an error and the app keeps working; replace the folder by
hand with a newer portable ZIP.

## Your data

| Data | Location | Touched by updates? |
| --- | --- | --- |
| Program files | `%LOCALAPPDATA%\aiostreams-integrated` (installed) or the portable folder | replaced |
| Server key, AIOStreams accounts, saved client sign-ins (all DPAPI), SQLite database, cache | `%LOCALAPPDATA%\AIOStreams Integrated\backend` | no |
| WebView2 profile, logs, downloads list | `%LOCALAPPDATA%\AIOStreams Integrated` | no |
| mpv settings and scripts, player preferences | `%APPDATA%\AIOStreams Integrated` | no |

The Windows update test checks that the server key, database and server
settings survive real updates; the installer upgrade test also checks
AIOStreams accounts.

## Rollback and recovery

Velopack does not go back to an older version automatically, and the app
never asks it to: an update may include upstream **database migrations**
(release notes warn about them), after which an older version may fail to
open the database. To go back safely:

1. **Before** updating, if you may want to return: close the app and copy
   `%LOCALAPPDATA%\AIOStreams Integrated` and `%APPDATA%\AIOStreams Integrated`
   somewhere safe. Use upstream's configuration export (AIOStreams
   Dashboard) for an additional, portable backup.
2. To return: close the app, run the older version's Setup from the
   [releases](https://github.com/AzizKamboh/aiostreams-desktop/releases)
   (Velopack installs it over the newer one), then, only if the newer version
   migrated the database, restore both folders from your backup.
3. Choose the channel you want in Settings → Updates; otherwise the app will
   offer the newer version again.

If an update leaves the app unable to start: run the newest Setup again
(repairs the program folder; data is kept), and see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md). Never delete the backend key to
"fix" startup — encrypted configurations depend on it.

## 0.2.x

0.2.1 and 0.2.2 shipped with the updater turned off. Install 0.3.0 once by
running its Setup (it upgrades in place, keeping all data); updates are
automatic from then on.

## For developers

- `packages/desktop/app/src/updates_integrated.rs` — the updater (compiled
  instead of upstream's `updates.rs`, which stays unchanged).
- `packages/desktop/app/src/update_policy.rs` — dependency-free rules
  (channels, feed URL, identity and version checks, backoff, disk space), also
  used by `scripts/release/feed-check`.
- `packages/web/src/lib/embedded-updates.ts`, `components/shell/embedded-updates.tsx` — Settings → Updates.
- `AIOSTREAMS_UPDATE_FEED` (environment) points a copy at another feed for
  tests; only HTTPS, loopback HTTP and local folders are accepted.
- Tests: `cargo test -p aiostreams-desktop` (rules),
  `scripts/desktop/native-update.mjs` (real Windows updates; run by
  `test-windows.ps1`), `scripts/release/feed-check` (published feeds).
