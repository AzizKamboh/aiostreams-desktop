# Upstream synchronisation

AIOStreams Integrated is an unofficial Windows distribution of
[Viren070/AIOStreams](https://github.com/Viren070/AIOStreams). Upstream owns the
server, providers, addons, stream pipeline, browsing interface, dashboard,
desktop client and mpv playback. This repository owns bundling, the private
local server, Windows storage, packaging, versioning, releases, the update
feed and this synchronisation. The goal is to stay as close to upstream as
practical: every upstream release should merge with as little manual work as
possible.

## What is tracked

[`.github/upstream-sync.json`](../.github/upstream-sync.json) records:

| Field | Meaning |
| --- | --- |
| `upstream.repository` | Upstream Git repository |
| `upstream.channel` | `stable` — only stable server (`vX.Y.Z`) and desktop (`desktop-vX.Y.Z`) release tags are followed. Nothing switches this to nightly. |
| `baseline.ref`, `baseline.commit` | The upstream tag and exact commit this tree integrates |
| `baseline.serverVersion`, `baseline.desktopVersion` | Upstream versions, read from upstream's `.release-please-manifest.json` at that commit |
| `baseline.integratedAt`, `baseline.status` | When the sync branch was prepared; `integrated` or `conflicted` |
| `baseline.changelogs` | Upstream release pages included by the last sync |
| `previous` | The baseline before the last sync |
| `blocked` | Upstream tags that must not be integrated yet, each `{ "ref": "v2.38.0", "reason": "…", "issue": "…" }` |

`SOURCE-MANIFEST.json` (shipped with the source archive) takes its
`upstreamCommit` from this file. [`scripts/upstream/hooks.json`](../scripts/upstream/hooks.json)
lists every upstream file the integration hooks into, the upstream contracts it
depends on, security-sensitive paths and dependency files; it is the
machine-readable form of [UPSTREAM-HOOKS.md](embedded-desktop/UPSTREAM-HOOKS.md).

## Git strategy: real merges with recorded ancestry

The repository was originally created from a *snapshot* of upstream
`desktop-v0.24.0`, without upstream's Git history, so Git could not merge a
newer upstream release: there was no common ancestor. Commit
`chore(upstream): record upstream desktop-v0.24.0 (76a5d6da) as an ancestor`
fixes this with a merge using the `ours` strategy. It changes no file — the
tree before and after is identical — and only records upstream commit
`76a5d6da` as a parent.

From then on every sync is an ordinary `git merge` of an upstream release
commit. Git's three-way merge uses the last integrated upstream release as the
base, so:

- upstream changes to files the integration never touched apply cleanly;
- integration-owned files (upstream has none of them) are never touched;
- upstream files with integration hooks merge line by line, and only a real
  overlap becomes a conflict;
- upstream authorship and history are preserved, and `git log`/`git blame`
  show where each change came from.

This was chosen over copying files (which would silently drop either side's
changes and needs a manual diff every time), rebasing (rewrites published
history and would require force-pushing `main`) and subtree/vendor layouts
(would move every upstream path and make every future merge conflict).

With the ancestry recorded, a trial merge of upstream `main` 24 commits past
`desktop-v0.24.0` completed with no conflicts.

## The automated flow

[`.github/workflows/upstream-sync.yml`](../.github/workflows/upstream-sync.yml) runs daily and on demand
(Actions → Upstream Sync → Run workflow; optionally name one stable tag).

1. **Detect** (read-only): `node scripts/upstream/sync.mjs detect` lists
   upstream's tags, picks the newest stable server and desktop releases
   (skipping `blocked` ones), takes the later of the two commits, and reads
   both versions from upstream's release-please manifest at that commit. If
   that commit is already in the baseline's history the run ends.
2. **Skip duplicates**: if branch `upstream-sync/<tag>` already exists the run
   stops; an open pull request is never duplicated and a branch someone is
   working on is never overwritten.
3. **Prepare**: `sync.mjs prepare` creates `upstream-sync/<tag>` from `main`,
   runs `git merge --no-ff <upstream commit>`, updates the tracking files and
   commits. It writes the pull-request description (report) and a result file.
4. **Pull request**: the branch is pushed and a pull request titled
   `chore(upstream): sync AIOStreams server X and desktop Y (<tag>)` is opened
   with the `upstream-sync` label. Older open sync pull requests get a
   "superseded" comment; nothing is closed automatically.
5. **Checks**: Pull Request CI and Integrated Windows desktop run on the
   branch (started with `workflow_dispatch` when GITHUB_TOKEN is used — see
   below). Branch protection keeps the pull request unmergeable until they
   pass and a reviewer approves.

Nothing is ever merged into `main` automatically.

### The report

The pull-request description lists previous and new upstream refs, SHAs and
versions, upstream release links, the number of upstream commits and changed
files (and how many are shipped in the Windows app), and these review sections:
conflicts, **integration hooks affected**, **shadowed upstream files** (for
example upstream's `updates.rs`, which the integrated updater replaces),
upstream contracts the integration depends on, potential breaking changes
(`!` commits, a changed desktop bridge `PROTOCOL_VERSION`), security-sensitive
commits and paths, dependency and Node runtime changes, database migrations,
upstream workflow changes, features/fixes, and a manual verification checklist.

Generate the same report locally for any upstream commit:

```sh
git fetch https://github.com/Viren070/AIOStreams.git main
node scripts/upstream/sync.mjs report --target FETCH_HEAD --out .upstream-sync
```

### Conflicts

If the merge conflicts, `prepare` does **not** pick a side. It commits the
merge with Git's conflict markers so no upstream or integration work is lost,
the report lists each conflicted file with the hook it carries, and the pull
request is opened as a **draft**. The *Repository checks → Conflict markers*
step in Pull Request CI fails until every marker is gone, so the pull request
cannot be merged by accident.

To resolve:

```sh
git fetch origin upstream-sync/<tag>
git switch upstream-sync/<tag>
git grep -nE '^(<<<<<<<|>>>>>>>)( |$)'
# Edit each file: keep upstream's new behaviour AND re-apply the integration hook
# (docs/embedded-desktop/UPSTREAM-HOOKS.md says what each hook is for).
node scripts/upstream/sync.mjs check-markers
git commit -am "fix(upstream): resolve <tag> merge conflicts"
git push
```

Then mark the pull request ready for review. Prefer moving integration logic
further into integration-owned files over growing a hook.

To redo the merge from scratch instead, close the pull request, delete the
`upstream-sync/<tag>` branch and run the workflow again.

### Blocking an upstream release

If an upstream release demonstrably breaks essential integrated functionality
and cannot be fixed in the sync pull request, add it to `blocked` in
`.github/upstream-sync.json` with the reason and a tracking issue, through a
normal pull request. Detection then skips that tag (a later upstream release is
still picked up, and contains the blocked one's changes, so a block is a
deferral, not a permanent pin). Remove the entry when a compatibility patch is
ready. Record compatibility patches in UPSTREAM-HOOKS.md.

### Upstream workflows

Upstream's workflows (Docker, Android, desktop, smart TV, nightly, release,
docs, …) arrive with every merge. Each of their jobs is limited with
`if: github.repository == 'Viren070/AIOStreams'` so they never run or publish
from this repository. *Repository checks → Upstream workflow guards* fails if
a merge brings a job without that guard; add it in the sync pull request.
Integration-owned workflows are listed in `scripts/upstream/hooks.json`
(`integrationWorkflows`).

## Credentials

### Default: GITHUB_TOKEN

Works with no setup. The `sync` job gets `contents`, `pull-requests`,
`issues` and `actions` write permission; `detect` is read-only. Two GitHub
limits apply:

- Pull requests and pushes made with GITHUB_TOKEN do not trigger
  `pull_request`/`push` workflows. The workflow therefore starts
  **Pull Request CI** and **Integrated Windows desktop** with
  `workflow_dispatch` on the sync branch (allowed for GITHUB_TOKEN). Their
  check runs attach to the branch's head commit and show on the pull request,
  and satisfy required checks of the same name. After you push conflict
  resolutions yourself, the normal `pull_request` triggers run.
- GITHUB_TOKEN cannot push commits that change `.github/workflows/*`. When an
  upstream release changes workflows, the run opens an issue with the report
  and the two commands to prepare and push the branch yourself.

Repository setting required: Settings → Actions → General → Workflow
permissions → **Allow GitHub Actions to create and approve pull requests**
(only the "create" part is used; the workflow never approves).

### Recommended: a GitHub App

Create a private GitHub App owned by your account (Settings → Developer settings
→ GitHub Apps → New), with no webhook, installed only on this repository, with
these **repository permissions**:

| Permission | Access | Why |
| --- | --- | --- |
| Contents | Read and write | push `upstream-sync/*` branches |
| Pull requests | Read and write | open and comment on sync pull requests |
| Workflows | Read and write | push merges that include upstream workflow changes |
| Issues | Read and write | report syncs that cannot be pushed |
| Metadata | Read | required |

Then add repository variable `UPSTREAM_SYNC_APP_ID` (the App ID) and secret
`UPSTREAM_SYNC_APP_PRIVATE_KEY` (a generated private key). The workflow then
uses a short-lived installation token, pull requests trigger the normal
`pull_request` checks, and workflow changes can be pushed. Keep the App out of
branch-protection bypass lists. Never use a personal access token.

## After merging a sync

1. Watch Integrated Windows desktop on `main`.
2. Update [UPSTREAM-HOOKS.md](embedded-desktop/UPSTREAM-HOOKS.md) if a hook moved.
3. Release a new integrated version (docs/RELEASE-PROCESS.md); its notes name
   the new upstream versions automatically.

## Contributing fixes upstream

Integration-independent bug fixes (for example the origin comparison in
`core/src/utils/http.ts`) are kept as small, separate commits so they can be
offered to Viren070/AIOStreams as ordinary pull requests from a fork. Do not
open issues or pull requests upstream for integrated-build-only behaviour.
