# Release process

**Upstream release → sync pull request → every check passes → merged → Preview published → Stable after 3 days.**

That chain is automatic (*Auto release*, below). Releases can also be made by
hand at any time (*Making a release*), and every release, automatic or not,
reaches installed apps only after *Release publishing* has verified it.

## Versions

Three versions, never mixed up:

| Version | Source of truth | Where it appears |
| --- | --- | --- |
| Integrated app (`0.3.0`) | [`integrated-version.json`](../integrated-version.json) | Git tag `v0.3.0`, release title, installer/Velopack package version, update feed, `INTEGRATED_VERSION` in the binary, Settings, diagnostics, release notes |
| Upstream server (`2.37.0`) | upstream `package.json` / `.release-please-manifest.json`, recorded in [`.github/upstream-sync.json`](../.github/upstream-sync.json) | Settings, diagnostics, release notes |
| Upstream desktop client (`0.24.0`) | upstream `packages/desktop/Cargo.toml`, recorded in the tracking file | Settings, bridge `version`, diagnostics, release notes |

The integrated version follows SemVer. Stable releases are `X.Y.Z`; preview
releases are `X.Y.Z-preview.N`, which sort before `X.Y.Z`.
`integrated-version.json` always holds the **next stable** version; previews
of it are `X.Y.Z-preview.1`, `-preview.2`, …
`node scripts/release/release.mjs check` (run by Pull Request CI) fails if
the tracked upstream versions disagree with the tree, or if RELEASE-NOTES.md
has no section for the committed version.

## Channels and feeds

| Channel | Tags | Velopack channel | Feed (a GitHub release apps read) | GitHub release |
| --- | --- | --- | --- | --- |
| Stable (default) | `vX.Y.Z` | `win-x64` | `updates-stable` | normal, marked Latest |
| Preview (opt-in) | `vX.Y.Z-preview.N` | `win-x64-preview` | `updates-preview` | pre-release |

The feed releases are machine-only (marked pre-release, never Latest).
Stable releases are added to the preview feed too, so preview users are
never left behind a newer stable version. See [AUTO-UPDATE.md](AUTO-UPDATE.md).

## Automatic releases

[`auto-release.yml`](../.github/workflows/auto-release.yml) runs every hour,
whenever a CI run finishes, and after each daily *Upstream Sync*. GitHub can
delay or skip scheduled runs, so the daily sync is the backstop: a Preview is
promoted at most about a day after its waiting time ends. Its decisions are pure functions in
[`scripts/release/auto.mjs`](../scripts/release/auto.mjs), tested in
`auto.test.mjs`.

| Step | What happens | When it waits for you |
| --- | --- | --- |
| 1. Sync | *Upstream Sync* (daily) opens a pull request for a new AIOStreams release (`upstream-sync/<tag>`) and, separately, for a new AIOMetadata release (`upstream-sync/aiometadata-<tag>`), and runs Pull Request CI and the Windows build on it | An upstream merge with conflicts opens as a draft, and an upstream release that changes workflows needs the GitHub App ([UPSTREAM-SYNC.md](UPSTREAM-SYNC.md)) |
| 2. Merge | A pull request labelled `upstream-sync` or `release-bump` merges itself once `windows-x64` (the real build, installer, playback and update tests), `Repository checks`, `TypeScript build and tests` and `Rust tests` all passed on its head. One that falls behind `main` is updated and re-checked | Any failed check; drafts; branch protection that requires an approval |
| 3. Preview | When `main` has app changes (anything but Markdown, `docs/`, `.github/`, `.gitignore`) that no release contains, *Integrated Windows desktop* builds `vX.Y.Z-preview.N`, creates the release and publishes it; *Release publishing* verifies it and puts it on the **preview** feed | A required reviewer on the `update-feed` environment, if you add one. A failed Preview build is not retried for the same commit: the next commit on `main`, or a manual run, tries again |
| 4. Stable | The newest Preview is rebuilt as `vX.Y.Z` and published to the **stable** feed once it has been out for `AUTO_STABLE_AFTER_DAYS` days (default 3) and `main` has no newer app changes | An open issue labelled **`release-blocker`** stops promotion until it is closed |
| 5. Next version | After a stable release, a `release-bump` pull request moves `integrated-version.json` to the next patch version and adds its RELEASE-NOTES.md section; it merges itself (step 2) | As step 2 |

Controls (Settings → Secrets and variables → Actions → **Variables**):

- `AUTO_RELEASE` = `off` stops all of it (the manual process below still works).
- `AUTO_STABLE_AFTER_DAYS` = a number of days, or `off` to promote only by hand.
- **Promote now**: Actions → *Auto release* → Run workflow with **promote**.
- **Stop a bad release reaching Stable**: open an issue with the label
  `release-blocker`. A bad Preview is replaced by fixing `main`: the next
  Preview follows within the hour (feeds never move backwards, so there is
  no un-publishing; see [AUTO-UPDATE.md](AUTO-UPDATE.md#rollback-and-recovery)).

Automatic merging uses the Actions token (or the sync GitHub App). If you
protect `main` with *Require approvals*, it cannot merge: sync pull requests
then wait for your approval, and everything after merging stays automatic.

## Making a release

1. **Prepare in a pull request**: set `integrated-version.json` to the
   version, write its `## X.Y.Z` section in [RELEASE-NOTES.md](../RELEASE-NOTES.md)
   (new features, fixes, security fixes, compatibility warnings), merge after
   review and green checks.
2. **Run** Actions → *Integrated Windows desktop* → **Run workflow** on
   `main` with:
   - `version`: `0.3.0` (stable) or `0.3.0-preview.1` (preview),
   - `channel`: matching `stable` or `preview`,
   - `draft_release`: ticked.
   The `plan` job rejects a version that does not match
   `integrated-version.json`, is not newer than the latest stable release,
   already exists (also as a draft), or belongs to the other channel — before
   anything is built.
3. The Windows job builds from that exact commit, packs Velopack packages
   (including a delta from the last published version of the channel), runs
   every test (backend smoke, installer, upgrade, playback, update tests),
   and verifies `SHA256SUMS.txt` and the feed.
4. The `draft-release` job checks the build's `BUILD-INFO.json` (version,
   channel, commit, package ID, update repository), re-checks the version
   against drafts, records a **build provenance attestation** for every
   package, and creates a **draft** release with generated notes
   (integrated and upstream versions, your release-notes section, upstream
   changes since the previous release, migration warnings, limitations,
   attribution, checksums) and all files:
   `…-Setup.exe`, `…-Portable.zip`, `*.nupkg` (full and delta),
   `releases.<channel>.json`, `assets.<channel>.json`, `RELEASES-<channel>`,
   `aiostreams-integrated-source.tar.gz`, `BUILD-INFO.json`, `SHA256SUMS.txt`.
5. **Review the draft**: edit the notes if needed, download and try the
   installer. Nothing is public yet.
6. **Publish** the draft. *Release publishing* then:
   - checks the tag, channel and pre-release flag agree;
   - downloads the release and re-verifies checksums, the feed metadata
     (package ID `aiostreams-integrated`, versions, hashes, safe names),
     `BUILD-INFO.json` against the tag's commit, and the attestation of every
     package against `embedded-desktop.yml`;
   - refuses to move a feed backwards;
   - uploads the packages to `updates-<channel>` first and the feed file last,
     removes older packages, adds stable releases to the preview feed, and
     marks a stable release as Latest;
   - runs *Post-release validation*.
7. *Post-release validation* downloads every file **anonymously** from its
   public URL and checks it, downloads the public feed, and runs
   `scripts/release/feed-check` — Velopack's own client code, the same
   version as the app, plus the app's update rules — as an installed `0.0.1`
   copy: it must find and download the new version, and a copy already on
   it must be told there is nothing newer. It also runs weekly for the latest
   stable release.

If publishing fails verification, the feed is untouched; fix the cause and
re-run *Release publishing* with the tag (workflow_dispatch), or delete the
release and make a new version. Never edit `updates-*` releases by hand.

To release an already-tested build without building again, pass
`reuse_run_id` (the earlier run on the same commit; only this workflow and
Markdown may have changed since).

## Optional approval gate for the feed

The feed job uses the GitHub environment `update-feed`. To require a second,
explicit approval before apps receive a published release, add required
reviewers to it: Settings → Environments → update-feed → Required reviewers.

## Verifying a download

```sh
sha256sum -c SHA256SUMS.txt --ignore-missing
gh attestation verify aiostreams-integrated-win-x64-Setup.exe -R AzizKamboh/aiostreams-desktop
```

Checksums only detect corruption; the attestation proves the file was built
by this repository's release workflow.

## Code signing (future)

Installers are unsigned. To sign later: obtain an Authenticode certificate
(or a cloud signing service such as Azure Trusted Signing), store its
credentials as repository secrets, and pass Velopack's signing options
(`vpk pack --signParams …` or `--azureTrustedSignFile …`) in
`package-windows.ps1` only when those secrets exist, so builds without them
keep working. Then pass `--signed` to `release.mjs notes`. Never commit
certificates or passwords.

## Repository settings (manual)

These need an owner; the workflows do not change them.

**Branch protection for `main`** (Settings → Branches → Add rule, or a ruleset):

- Require a pull request before merging; require 1 approval; dismiss stale
  approvals on new commits; require review from Code Owners for sensitive
  paths if you add a `CODEOWNERS` file (for example `.github/`,
  `scripts/release/`, `packages/desktop/app/src/updates_integrated.rs`).
- Require status checks to pass, and the branch to be up to date:
  `Repository checks`, `TypeScript build and tests`, `Rust tests`,
  `windows-x64`. (Checks skipped because nothing relevant changed count as
  passing.)
- Require conversation resolution; block force pushes; do not allow
  deletion.
- Do not allow bypassing the above, and do not add the sync App to bypass
  lists. Enable "Include administrators" (or "Do not allow bypassing").

**Actions** (Settings → Actions → General):

- Workflow permissions: **Read repository contents** by default (every
  workflow raises permissions per job only where needed).
- Allow GitHub Actions to **create** pull requests (used by Upstream Sync with
  GITHUB_TOKEN).
- Fork pull request workflows: require approval for first-time contributors.

**Security** (Settings → Code security): enable private vulnerability
reporting, Dependabot alerts and secret scanning with push protection.

**Optional credentials**: the Upstream Sync GitHub App
(`UPSTREAM_SYNC_APP_ID` variable, `UPSTREAM_SYNC_APP_PRIVATE_KEY` secret),
see [UPSTREAM-SYNC.md](UPSTREAM-SYNC.md#recommended-a-github-app). No other
secrets are used.

**Repository description and topics** (About → ⚙): description
"Unofficial Windows desktop build of AIOStreams with its own built-in server —
one installer, no Docker. Based on Viren070/AIOStreams."; topics `aiostreams`,
`stremio`, `windows`, `desktop-app`, `mpv`, `webview2`, `debrid`, `usenet`,
`velopack`, `self-hosted`.
