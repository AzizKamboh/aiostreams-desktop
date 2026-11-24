// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { chooseUpdate, compare, rewriteDoc, tagCommit, VERSIONED_DOCS } from './aiometadata.mjs';

const pin = { version: '4.1.0', tag: 'v4.1.0', commit: 'bb8610d52ad750581c20b1caf1561a7673f04635' };
const release = (tag, publishedAt = '2026-12-01T00:00:00Z', extra = {}) => ({
  tag_name: tag, published_at: publishedAt, html_url: `https://example.test/${tag}`, draft: false, prerelease: false, ...extra,
});

test('versions compare numerically', () => {
  assert.equal(compare('4.10.0', '4.9.9'), 1);
  assert.equal(compare('4.1.0', '4.1.0'), 0);
  assert.throws(() => compare('4.1.0-beta', '4.1.0'));
});

test('a newer latest release is offered', () => {
  const d = chooseUpdate({ pin, latest: release('v4.2.0'), pinnedPublishedAt: '2026-11-18T04:50:00Z' });
  assert.equal(d.status, 'available');
  assert.deepEqual(d.target.version, '4.2.0');
});

test('the same, older, odd or pre-release versions are not', () => {
  assert.equal(chooseUpdate({ pin, latest: release('v4.1.0') }).status, 'current');
  assert.equal(chooseUpdate({ pin, latest: release('v4.0.0') }).status, 'current');
  assert.equal(chooseUpdate({ pin, latest: release('v.testing.20261118.1') }).status, 'current');
  assert.equal(chooseUpdate({ pin, latest: release('v4.2.0', undefined, { prerelease: true }) }).status, 'current');
  assert.equal(chooseUpdate({ pin, latest: null }).status, 'current');
});

test('a higher but older tag (the stray v5.0.0) is not taken', () => {
  const d = chooseUpdate({ pin, latest: release('v5.0.0', '2025-07-30T21:48:41Z'), pinnedPublishedAt: '2026-11-18T04:50:00Z' });
  assert.equal(d.status, 'current');
});

test('annotated tags resolve to the commit, lightweight tags to themselves', () => {
  const annotated = 'aaa\trefs/tags/v4.2.0\nbbb\trefs/tags/v4.2.0^{}\n';
  assert.equal(tagCommit(annotated, 'v4.2.0'), 'bbb');
  assert.equal(tagCommit('ccc\trefs/tags/v4.2.0\n', 'v4.2.0'), 'ccc');
  assert.throws(() => tagCommit('', 'v4.2.0'));
});

test('docs naming the pinned version are rewritten, and still name it today', () => {
  const to = { version: '4.2.0', commit: 'c'.repeat(40) };
  const text = 'AIOMetadata 4.1.0 (x) | source/aiometadata-4.1.0-source.tar.gz, from commit `bb8610d5`';
  assert.equal(rewriteDoc(text, pin, to), 'AIOMetadata 4.2.0 (x) | source/aiometadata-4.2.0-source.tar.gz, from commit `cccccccc`');
  const pins = JSON.parse(fs.readFileSync(new URL('../desktop/runtime-pins.json', import.meta.url)));
  for (const doc of VERSIONED_DOCS) {
    const current = fs.readFileSync(new URL(`../../${doc}`, import.meta.url), 'utf8');
    assert.notEqual(rewriteDoc(current, pins.aiometadata, to), current, `${doc} no longer names the pinned AIOMetadata`);
  }
});
