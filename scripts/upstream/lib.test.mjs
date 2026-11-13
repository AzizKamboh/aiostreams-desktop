// SPDX-License-Identifier: AGPL-3.0-only
// node --test scripts/upstream/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  chooseTarget,
  classifyChanges,
  compareVersions,
  groupCommits,
  hasConflictMarkers,
  latestTags,
  parseReleaseTags,
  releaseLinks,
  renderReport,
  versionsFromManifest,
} from './lib.mjs';
import { unguardedJobs } from './sync.mjs';

const upstream = JSON.parse(fs.readFileSync(new URL('../../.github/upstream-sync.json', import.meta.url))).upstream;
const hooks = JSON.parse(fs.readFileSync(new URL('./hooks.json', import.meta.url)));
const sha = (n) => String(n).repeat(40).slice(0, 40);

const LS_REMOTE = [
  `${sha(1)}\trefs/tags/v2.37.0`,
  `${sha(2)}\trefs/tags/v2.38.0`,
  `${sha(9)}\trefs/tags/v2.38.0^{}`,
  `${sha(3)}\trefs/tags/desktop-v0.24.0`,
  `${sha(4)}\trefs/tags/desktop-v0.25.0`,
  `${sha(5)}\trefs/tags/v2.39.0-beta.1`,
  `${sha(6)}\trefs/tags/android-v0.15.0`,
  `${sha(7)}\trefs/tags/desktop-nightly`,
  `${sha(8)}\trefs/tags/v2.9.0`,
].join('\n');

test('versions compare numerically, and only stable versions are accepted', () => {
  assert.equal(compareVersions('2.10.0', '2.9.9'), 1);
  assert.equal(compareVersions('0.24.0', '0.24.0'), 0);
  assert.throws(() => compareVersions('2.39.0-beta.1', '2.38.0'));
});

test('only stable server and desktop tags are tracked; peeled commits win', () => {
  const tags = parseReleaseTags(LS_REMOTE, upstream);
  const names = tags.map((t) => t.name).sort();
  assert.deepEqual(names, ['desktop-v0.24.0', 'desktop-v0.25.0', 'v2.37.0', 'v2.38.0', 'v2.9.0']);
  assert.equal(tags.find((t) => t.name === 'v2.38.0').commit, sha(9));
});

test('latest tags skip blocked releases', () => {
  const tags = parseReleaseTags(LS_REMOTE, upstream);
  assert.equal(latestTags(tags).server.name, 'v2.38.0');
  assert.equal(latestTags(tags, [{ ref: 'v2.38.0', reason: 'breaks login' }]).server.name, 'v2.37.0');
  assert.equal(latestTags(tags).desktop.name, 'desktop-v0.25.0');
});

test('the target is the descendant of the two latest release commits', () => {
  const server = { name: 'v2.38.0', commit: 'a', kind: 'server' };
  const desktop = { name: 'desktop-v0.25.0', commit: 'b', kind: 'desktop' };
  const time = () => 0;
  assert.equal(chooseTarget({ server, desktop }, (x, y) => x === 'a' && y === 'b', time), desktop);
  assert.equal(chooseTarget({ server, desktop }, (x, y) => x === 'b' && y === 'a', time), server);
  assert.equal(chooseTarget({ server, desktop }, () => false, (c) => (c === 'a' ? 2 : 1)), server);
  assert.equal(chooseTarget({ server }, () => false, time), server);
  assert.equal(chooseTarget({}, () => false, time), null);
});

test('versions come from the release-please manifest', () => {
  assert.deepEqual(versionsFromManifest('{".":"2.38.0","packages/desktop":"0.25.0"}'), { serverVersion: '2.38.0', desktopVersion: '0.25.0' });
});

test('changed files are classified for review', () => {
  const c = classifyChanges([
    'packages/server/src/app.ts',
    'packages/desktop/app/src/updates.rs',
    'packages/core/src/db/migrations/0006_new.ts',
    'packages/core/src/utils/permissions.ts',
    'pnpm-lock.yaml',
    'packages/web/package.json',
    '.github/workflows/desktop-build.yml',
    'packages/android/app/build.gradle.kts',
    'docs/whatever.md',
  ], hooks);
  assert.deepEqual(c.hooks, ['packages/server/src/app.ts', '.github/workflows/desktop-build.yml']);
  assert.deepEqual(c.shadowed, ['packages/desktop/app/src/updates.rs']);
  assert.ok(c.contracts.includes('packages/core/src/utils/permissions.ts'));
  assert.ok(c.contracts.includes('packages/core/src/db/migrations/0006_new.ts'));
  assert.deepEqual(c.migrations, ['packages/core/src/db/migrations/0006_new.ts']);
  assert.ok(c.security.includes('packages/server/src/app.ts'));
  assert.ok(c.security.includes('packages/desktop/app/src/updates.rs'));
  assert.deepEqual(c.dependencies, ['pnpm-lock.yaml', 'packages/web/package.json']);
  assert.deepEqual(c.workflows, ['.github/workflows/desktop-build.yml']);
  assert.deepEqual(c.notShipped, ['packages/android/app/build.gradle.kts', 'docs/whatever.md']);
});

test('every hooked and contract path in hooks.json exists in the repository', () => {
  for (const group of [hooks.hookedUpstreamFiles, hooks.shadowedUpstreamFiles, hooks.contracts]) {
    for (const file of Object.keys(group)) assert.ok(fs.existsSync(new URL(`../../${file}`, import.meta.url)), `${file} is missing`);
  }
});

test('commit subjects are grouped by conventional type', () => {
  const g = groupCommits(['feat(web): x', 'fix(core): y', 'fix(server): redact tokens in logs', 'feat!: drop z', 'chore: w']);
  assert.deepEqual(g.features, ['feat(web): x']);
  assert.deepEqual(g.fixes, ['fix(core): y']);
  assert.deepEqual(g.security, ['fix(server): redact tokens in logs']);
  assert.deepEqual(g.breaking, ['feat!: drop z']);
  assert.deepEqual(g.other, ['chore: w']);
});

test('release links cover exactly the releases since the baseline', () => {
  const tags = parseReleaseTags(LS_REMOTE, upstream);
  const links = releaseLinks(tags, { serverVersion: '2.37.0', desktopVersion: '0.24.0' }, { serverVersion: '2.38.0', desktopVersion: '0.25.0' }, 'https://github.com/Viren070/AIOStreams');
  assert.deepEqual(links.map((l) => l.name), ['desktop-v0.25.0', 'v2.38.0']);
});

test('conflict markers are detected, ordinary separators are not', () => {
  assert.ok(hasConflictMarkers('a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> upstream\n'));
  assert.ok(!hasConflictMarkers('Title\n=======\n'));
  assert.ok(!hasConflictMarkers('a <<<<<<< b'));
});

test('unguarded upstream workflow jobs are found', () => {
  const yaml = `on: push\njobs:\n  build:\n    if: github.repository == 'Viren070/AIOStreams'\n    runs-on: x\n  publish:\n    runs-on: x\n    steps:\n      - if: github.repository == 'Viren070/AIOStreams'\n`;
  assert.deepEqual(unguardedJobs(yaml), ['publish']);
});

test('the report names conflicts, hooks and the review requirement', () => {
  const report = renderReport({
    repository: 'https://github.com/Viren070/AIOStreams',
    baseline: { ref: 'desktop-v0.24.0', commit: sha(1), serverVersion: '2.37.0', desktopVersion: '0.24.0' },
    target: { ref: 'desktop-v0.25.0', commit: sha(2), serverVersion: '2.38.0', desktopVersion: '0.25.0' },
    conflicts: ['packages/server/src/app.ts'],
    hooks,
    classification: classifyChanges(['packages/server/src/app.ts'], hooks),
    commits: groupCommits(['feat!: x']),
    commitCount: 1,
    releases: [],
    protocolChanged: true,
    nodeChange: '24.18.1 → 24.19.0',
  });
  assert.match(report, /This merge has conflicts/);
  assert.match(report, /## Conflicts \(1\)\n- `packages\/server\/src\/app.ts` — installDesktop/);
  assert.match(report, /PROTOCOL_VERSION/);
  assert.match(report, /24\.18\.1 → 24\.19\.0/);
  assert.match(report, /Review required/);
});
