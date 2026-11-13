# Release process

**Reviewed code → Windows CI passes → draft release → human review → publish → feed verified → apps update.**

Nothing reaches installed apps until a person publishes a draft and the
publishing workflow has verified it.

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
