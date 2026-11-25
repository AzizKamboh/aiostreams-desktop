// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addNotesSection, automergeDecision, bumpDecision, nextPatch, previewDecision, releaseRelevant, stableDecision,
} from './auto.mjs';
import { notesSection } from './lib.mjs';

const pr = (extra = {}) => ({
  number: 7, headRefName: 'upstream-sync/desktop-v0.29.0', headRefOid: 'a'.repeat(40), isDraft: false,
  isCrossRepository: false, mergeStateStatus: 'CLEAN', labels: [{ name: 'upstream-sync' }], ...extra,
});
const green = [
  { name: 'windows-x64', status: 'completed', conclusion: 'success' },
  { name: 'Repository checks', status: 'completed', conclusion: 'success' },
  { name: 'TypeScript build and tests', status: 'completed', conclusion: 'success' },
  { name: 'Rust tests', status: 'completed', conclusion: 'skipped' },
  { name: 'draft-release', status: 'completed', conclusion: 'skipped' },
];
const withRun = (name, status, conclusion) => green.map((r) => (r.name === name ? { ...r, status, conclusion } : r));

test('a green sync pull request merges itself', () => {
  assert.equal(automergeDecision(pr(), green).merge, true);
  assert.equal(automergeDecision(pr({ labels: [{ name: 'release-bump' }], headRefName: 'release/bump-0.3.1' }), green).merge, true);
});

test('anything short of every check passing waits or refuses', () => {
  assert.equal(automergeDecision(pr(), withRun('windows-x64', 'in_progress', null)).waiting, true);
  assert.equal(automergeDecision(pr(), withRun('windows-x64', 'completed', 'failure')).merge, false);
  assert.equal(automergeDecision(pr(), withRun('windows-x64', 'completed', 'skipped')).merge, false, 'the Windows build must really run');
  assert.equal(automergeDecision(pr(), withRun('Repository checks', 'completed', 'cancelled')).merge, false);
  assert.equal(automergeDecision(pr(), green.filter((r) => r.name !== 'Rust tests')).waiting, true);
});

test('only labelled same-repository branches outside drafts qualify', () => {
  assert.equal(automergeDecision(pr({ labels: [] }), green).merge, false);
  assert.equal(automergeDecision(pr({ headRefName: 'feature/x' }), green).merge, false);
  assert.equal(automergeDecision(pr({ labels: [{ name: 'release-bump' }] }), green).merge, false, 'label and branch must agree');
  assert.equal(automergeDecision(pr({ isCrossRepository: true }), green).merge, false);
  assert.equal(automergeDecision(pr({ isDraft: true }), green).merge, false, 'conflicted syncs open as drafts');
  assert.equal(automergeDecision(pr({ mergeStateStatus: 'BEHIND' }), green).merge, false);
  assert.equal(automergeDecision(pr({ mergeStateStatus: 'BEHIND' }), green).update, true);
  assert.equal(automergeDecision(pr({ mergeStateStatus: 'DIRTY' }), green).merge, false);
});

test('only app changes need a release', () => {
  for (const f of ['README.md', 'docs/X.md', '.github/workflows/a.yml', 'integrated-version.json', 'SOURCE-MANIFEST.json', '.gitignore']) {
    assert.equal(releaseRelevant(f), false, f);
  }
  for (const f of ['packages/web/src/app.tsx', 'scripts/desktop/runtime-pins.json', 'pnpm-lock.yaml', 'packages/desktop/app/src/main.rs']) {
    assert.equal(releaseRelevant(f), true, f);
  }
});

test('the version moves on only after it shipped as stable', () => {
  assert.equal(nextPatch('0.3.0'), '0.3.1');
  assert.throws(() => nextPatch('0.3.0-preview.1'));
  assert.deepEqual(bumpDecision({ committed: '0.3.0', publishedTags: ['v0.2.2', 'v0.3.0-preview.1'] }).bump, false);
  assert.equal(bumpDecision({ committed: '0.3.0', publishedTags: ['v0.3.0'] }).version, '0.3.1');
});

test('previews number on from every existing tag, drafts included', () => {
  const base = { committed: '0.3.0', publishedTags: ['v0.2.2'], changedSinceRelease: ['a.ts'], buildRunning: false };
  assert.equal(previewDecision({ ...base, existingTags: ['v0.2.2'] }).version, '0.3.0-preview.1');
  assert.equal(previewDecision({ ...base, existingTags: ['v0.2.2', 'v0.3.0-preview.1', 'v0.3.0-preview.3'] }).version, '0.3.0-preview.4');
  assert.equal(previewDecision({ ...base, existingTags: [], changedSinceRelease: null }).version, '0.3.0-preview.1');
});

test('no preview without changes, during a build, or before the bump', () => {
  const base = { committed: '0.3.0', existingTags: [], publishedTags: ['v0.2.2'], changedSinceRelease: ['a.ts'], buildRunning: false };
  assert.equal(previewDecision({ ...base, changedSinceRelease: [] }).action, 'none');
  assert.equal(previewDecision({ ...base, buildRunning: true }).action, 'none');
  assert.equal(previewDecision({ ...base, publishedTags: ['v0.3.0'] }).action, 'none');
  assert.equal(previewDecision({ ...base, failedForHead: true }).action, 'none');
});

const day = 86400000;
const now = Date.parse('2026-12-10T00:00:00Z');
const stableBase = {
  previews: [{ version: '0.3.0-preview.1', publishedAt: new Date(now - 5 * day).toISOString() },
    { version: '0.3.0-preview.2', publishedAt: new Date(now - 4 * day).toISOString() }],
  existingTags: ['v0.2.2', 'v0.3.0-preview.1', 'v0.3.0-preview.2'],
  days: 3, now, force: false, blockers: 0, changedSincePreview: [], buildRunning: false,
};

test('the newest preview becomes stable after its waiting time', () => {
  const d = stableDecision(stableBase);
  assert.equal(d.promote, true);
  assert.equal(d.version, '0.3.0');
  assert.equal(d.from, '0.3.0-preview.2');
});

test('promotion waits for time, blockers, newer code and running builds', () => {
  assert.equal(stableDecision({ ...stableBase, days: 7 }).promote, false);
  assert.equal(stableDecision({ ...stableBase, days: null }).promote, false, 'off');
  assert.equal(stableDecision({ ...stableBase, days: null, force: true }).promote, true, 'promote now');
  assert.equal(stableDecision({ ...stableBase, blockers: 1, force: true }).promote, false);
  assert.equal(stableDecision({ ...stableBase, changedSincePreview: ['x.ts'], force: true }).promote, false);
  assert.equal(stableDecision({ ...stableBase, buildRunning: true }).promote, false);
  assert.equal(stableDecision({ ...stableBase, existingTags: [...stableBase.existingTags, 'v0.3.0'] }).promote, false);
  assert.equal(stableDecision({ ...stableBase, previews: [] }).promote, false);
});

test('a bumped version gets the notes section release.mjs check requires', () => {
  const notes = '# Notes\n\n## 0.3.0\n\nText.\n';
  const out = addNotesSection(notes, '0.3.1', '0.3.0');
  assert.notEqual(notesSection(out, '0.3.1'), null);
  assert.ok(out.indexOf('## 0.3.1') < out.indexOf('## 0.3.0'));
  assert.equal(addNotesSection(out, '0.3.1', '0.3.0'), out);
});
