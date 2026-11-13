// SPDX-License-Identifier: AGPL-3.0-only
// Pure helpers for the upstream synchronisation: no git, network or file I/O,
// so scripts/upstream/lib.test.mjs can test them with `node --test`.

/** Parses SemVer core `x.y.z` into numbers, or null. */
export function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text ?? '');
  return match ? match.slice(1, 4).map(Number) : null;
}

export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (!x || !y) throw new Error(`Not a stable version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/**
 * Stable server and desktop release tags from `git ls-remote --tags` output.
 * Annotated tags appear twice; the peeled (`^{}`) line names the commit.
 */
export function parseReleaseTags(lsRemote, upstream) {
  const server = new RegExp(upstream.serverTagPattern);
  const desktop = new RegExp(upstream.desktopTagPattern);
  const commits = new Map();
  for (const line of lsRemote.split('\n')) {
    const match = /^([0-9a-f]{40})\s+refs\/tags\/(.+?)(\^\{\})?$/.exec(line.trim());
    if (!match) continue;
    const [, sha, name, peeled] = match;
    if (peeled || !commits.has(name)) commits.set(name, sha);
  }
  const tags = [];
  for (const [name, commit] of commits) {
    for (const [kind, pattern] of [['server', server], ['desktop', desktop]]) {
      const match = pattern.exec(name);
      if (match && parseVersion(match[1])) tags.push({ name, commit, kind, version: match[1] });
    }
  }
  return tags;
}

/** The newest stable tag of each kind, skipping blocked refs. */
export function latestTags(tags, blocked = []) {
  const skip = new Set(blocked.map((entry) => entry.ref));
  const latest = {};
  for (const tag of tags) {
    if (skip.has(tag.name)) continue;
    if (!latest[tag.kind] || compareVersions(tag.version, latest[tag.kind].version) > 0) latest[tag.kind] = tag;
  }
  return latest;
}

/**
 * The integration target: the newer of the latest server and desktop release
 * commits. `isAncestor(a, b)` says whether commit a is an ancestor of b.
 * Upstream tags both kinds from the same main branch, so one normally
 * contains the other; otherwise the later commit time wins.
 */
export function chooseTarget(latest, isAncestor, commitTime) {
  const candidates = [latest.server, latest.desktop].filter(Boolean);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const [a, b] = candidates;
  if (a.commit === b.commit) return a.kind === 'desktop' ? a : b;
  if (isAncestor(a.commit, b.commit)) return b;
  if (isAncestor(b.commit, a.commit)) return a;
  return commitTime(a.commit) >= commitTime(b.commit) ? a : b;
}

/** Versions recorded by upstream's release-please manifest at a commit. */
export function versionsFromManifest(manifestText) {
  const manifest = JSON.parse(manifestText);
  return { serverVersion: manifest['.'] ?? null, desktopVersion: manifest['packages/desktop'] ?? null };
}

function matches(file, pattern) {
  if (pattern.endsWith('/')) return file.startsWith(pattern);
  if (pattern.includes('*')) {
    const regex = new RegExp('^' + pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
    return regex.test(file);
  }
  return file === pattern;
}

const anyMatch = (file, patterns) => patterns.some((pattern) => matches(file, pattern));

/** Sorts upstream's changed files into the categories a reviewer must check. */
export function classifyChanges(files, hooks) {
  const hooked = Object.keys(hooks.hookedUpstreamFiles);
  const shadowed = Object.keys(hooks.shadowedUpstreamFiles ?? {});
  const contracts = Object.keys(hooks.contracts);
  const result = { total: files.length, hooks: [], shadowed: [], contracts: [], security: [], dependencies: [], migrations: [], workflows: [], notShipped: [], shipped: [] };
  for (const file of files) {
    if (anyMatch(file, hooked)) result.hooks.push(file);
    if (anyMatch(file, shadowed)) result.shadowed.push(file);
    if (anyMatch(file, contracts)) result.contracts.push(file);
    if (anyMatch(file, hooks.securityPaths)) result.security.push(file);
    if (anyMatch(file, hooks.dependencyFiles)) result.dependencies.push(file);
    if (file.startsWith('packages/core/src/db/migrations/')) result.migrations.push(file);
    if (file.startsWith('.github/workflows/')) result.workflows.push(file);
    if (anyMatch(file, hooks.notShippedInWindowsApp) || file.endsWith('.md')) result.notShipped.push(file);
    else result.shipped.push(file);
  }
  return result;
}

/** Explanation shown for a hooked or contract path. */
export function describePath(file, hooks) {
  for (const group of [hooks.hookedUpstreamFiles, hooks.integrationReplacedFiles ?? {}, hooks.shadowedUpstreamFiles ?? {}, hooks.contracts]) {
    for (const [pattern, why] of Object.entries(group)) if (matches(file, pattern)) return why;
  }
  return '';
}

const SECTIONS = [
  ['security', /^(fix|feat)(\(.+\))?!?:.*\b(secur|auth|permission|token|secret|xss|csrf|ssrf|inject|sanitiz|redact|cve)/i],
  ['breaking', /^\w+(\(.+\))?!:|BREAKING CHANGE/],
  ['features', /^feat(\(.+\))?:/],
  ['fixes', /^fix(\(.+\))?:/],
];

/** Groups upstream commit subjects by conventional-commit type. */
export function groupCommits(subjects) {
  const groups = { security: [], breaking: [], features: [], fixes: [], other: [] };
  for (const subject of subjects) {
    const section = SECTIONS.find(([, pattern]) => pattern.test(subject));
    groups[section ? section[0] : 'other'].push(subject);
  }
  return groups;
}

/** Release pages for every stable tag in (baseline, target]. */
export function releaseLinks(tags, baseline, target, repository) {
  const links = [];
  for (const tag of tags) {
    const previous = tag.kind === 'server' ? baseline.serverVersion : baseline.desktopVersion;
    const next = tag.kind === 'server' ? target.serverVersion : target.desktopVersion;
    if (!previous || !next) continue;
    if (compareVersions(tag.version, previous) > 0 && compareVersions(tag.version, next) <= 0) {
      links.push({ name: tag.name, url: `${repository}/releases/tag/${tag.name}`, kind: tag.kind, version: tag.version });
    }
  }
  return links.sort((a, b) => a.kind.localeCompare(b.kind) || compareVersions(a.version, b.version));
}

/** Text that git leaves in a file with an unresolved conflict. */
export function hasConflictMarkers(text) {
  return /^(<{7}|>{7}) /m.test(text) || /^<{7}$|^>{7}$/m.test(text);
}

const list = (items, render = (item) => `- \`${item}\``, limit = 40) =>
  items.length === 0
    ? '- none\n'
    : items.slice(0, limit).map(render).join('\n') + (items.length > limit ? `\n- …and ${items.length - limit} more` : '') + '\n';

/** The pull-request description for a sync branch. */
export function renderReport(r) {
  const c = r.classification;
  const describe = (file) => {
    const why = describePath(file, r.hooks);
    return `- \`${file}\`${why ? ` — ${why}` : ''}`;
  };
  const conflicted = r.conflicts.length > 0;
  return `${conflicted ? '> [!CAUTION]\n> **This merge has conflicts.** The conflicted files are committed with their conflict markers so no work is lost; the *Conflict markers* check fails until they are resolved. Resolve them on this branch (see docs/UPSTREAM-SYNC.md), keeping both upstream behaviour and the integration hook.\n\n' : ''}Automated upstream synchronisation from [Viren070/AIOStreams](${r.repository}) (stable releases). **Review required — do not merge until Pull Request CI and Integrated Windows desktop pass and the manual checks below are done.**

| | Previous | New |
| --- | --- | --- |
| Upstream ref | \`${r.baseline.ref}\` | \`${r.target.ref}\` |
| Commit | \`${r.baseline.commit}\` | \`${r.target.commit}\` |
| Server version | ${r.baseline.serverVersion} | ${r.target.serverVersion} |
| Desktop client version | ${r.baseline.desktopVersion} | ${r.target.desktopVersion} |

Upstream commits: ${r.commitCount} · changed files: ${c.total} (${c.shipped.length} shipped in the Windows app, ${c.notShipped.length} not shipped) · [compare](${r.repository}/compare/${r.baseline.commit}...${r.target.commit})

## Upstream release notes
${list(r.releases, (link) => `- [${link.name}](${link.url})`)}
${conflicted ? `## Conflicts (${r.conflicts.length})
${list(r.conflicts, describe, 200)}
` : ''}${r.keptOurs?.length ? `## Integration-replaced files (this repository's version kept)
Upstream changed these files, which this repository replaces wholesale. Check whether anything in upstream's change should be carried over by hand.

${list(r.keptOurs, describe)}
` : ''}## Integration hooks affected
Upstream changed files that carry integration hooks. Check that each hook still applies and still does its job.

${list(c.hooks, describe)}
## Shadowed upstream files
Files the integration replaces at build time. Port relevant upstream fixes to the integrated counterpart.

${list(c.shadowed, describe)}
## Contracts the integration depends on
${list(c.contracts, describe)}
## Potential breaking changes
${list(r.commits.breaking, (s) => `- ${s}`)}${r.protocolChanged ? '- **Desktop bridge `PROTOCOL_VERSION` changed** — check `embedded.rs` and the integrated updater messages.\n' : ''}
## Security-sensitive changes
${list(r.commits.security, (s) => `- ${s}`)}${list(c.security)}
## Dependency and runtime changes
${list(c.dependencies)}${r.nodeChange ? `- Upstream Node runtime: ${r.nodeChange} — update \`scripts/desktop/runtime-pins.json\` (Node ABI must match native modules).\n` : ''}
## Database migrations
${c.migrations.length ? `${list(c.migrations)}New migrations make downgrading to an older integrated release unsafe; note this in the release notes (docs/AUTO-UPDATE.md, *Rollback*).\n` : '- none\n'}
## Upstream workflow changes
${c.workflows.length ? `${list(c.workflows)}Confirm each upstream publishing job still carries \`if: github.repository == 'Viren070/AIOStreams'\` (the *Upstream workflow guards* check verifies this).\n` : '- none\n'}
## New features and fixes
<details><summary>${r.commits.features.length} features, ${r.commits.fixes.length} fixes, ${r.commits.other.length} other</summary>

### Features
${list(r.commits.features, (s) => `- ${s}`, 200)}
### Fixes
${list(r.commits.fixes, (s) => `- ${s}`, 200)}
### Other
${list(r.commits.other, (s) => `- ${s}`, 200)}
</details>

## Test results
Automated results are the checks on this pull request: **Pull Request CI** (TypeScript build and tests, Rust tests, sync checks) and **Integrated Windows desktop** (real Windows build, installer, upgrade, update, WebView2 and mpv playback). Fixture-based CI does not exercise real debrid, Usenet or addon accounts.

## Manual verification
- [ ] All required checks pass on the latest commit of this branch
- [ ] Hooks listed above still apply (docs/embedded-desktop/UPSTREAM-HOOKS.md updated if they moved)
- [ ] First-run account setup and built-in Usenet account check
- [ ] AIOStreams Dashboard, configuration and Usenet providers open from the app
- [ ] Remote server switch and back
- [ ] Real provider smoke test (debrid / Usenet / addon) on a Windows machine
- [ ] Release notes for the next integrated version mention this upstream update

Generated by \`scripts/upstream/sync.mjs\`. Tracking: \`.github/upstream-sync.json\`.
`;
}
