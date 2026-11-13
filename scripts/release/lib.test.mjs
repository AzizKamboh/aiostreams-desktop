// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import test from 'node:test';
import { channelOf, compareSemver, mergeFeed, notesSection, parseChecksums, renderReleaseNotes, validateRelease, verifyFeed } from './lib.mjs';

const SHA = 'a'.repeat(64);

test('SemVer precedence follows the specification', () => {
  const order = ['0.2.2', '0.3.0-preview.1', '0.3.0-preview.2', '0.3.0-preview.10', '0.3.0', '0.10.0'];
  for (let i = 1; i < order.length; i++) assert.equal(compareSemver(order[i - 1], order[i]), -1, `${order[i - 1]} < ${order[i]}`);
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
});

test('channels are derived from the version', () => {
  assert.equal(channelOf('0.3.0'), 'stable');
  assert.equal(channelOf('0.3.0-preview.1'), 'preview');
  assert.equal(channelOf('0.3.0-nightly.1'), null);
  assert.equal(channelOf('0.3.0-preview.0'), null);
  assert.equal(channelOf('v0.3.0'), null);
});

const existing = ['v0.2.1', 'v0.2.2', 'v0.3.0-preview.1', 'updates-stable', 'desktop-v0.24.0'];

test('valid stable and preview releases pass', () => {
  assert.deepEqual(validateRelease({ version: '0.3.0', channel: 'stable', committedVersion: '0.3.0', existing }), []);
  assert.deepEqual(validateRelease({ version: '0.3.0-preview.2', channel: 'preview', committedVersion: '0.3.0', existing }), []);
});

test('duplicates, downgrades, mismatches and wrong channels are rejected', () => {
  const v = (version, channel = 'stable', committedVersion = '0.3.0') => validateRelease({ version, channel, committedVersion, existing }).join(' ');
  assert.match(v('0.3.0-preview.1', 'preview'), /already exists/);
  assert.match(v('0.2.2', 'stable', '0.2.2'), /already exists/);
  assert.match(v('0.2.1', 'stable', '0.2.1'), /already exists|newer than the latest stable/);
  assert.match(v('0.2.0', 'stable', '0.2.0'), /newer than the latest stable/);
  assert.match(v('0.3.1'), /does not match integrated-version.json/);
  assert.match(v('0.3.0', 'preview'), /stable version but the preview channel/);
  assert.match(v('0.3.0-preview.3'), /preview version but the stable channel/);
  assert.match(v('0.3.0-beta.1'), /not a release version/);
  assert.match(v('0.3.0', 'nightly'), /Unknown channel/);
  assert.match(validateRelease({ version: '0.3.0-preview.1', channel: 'preview', committedVersion: '0.3.0', existing: ['v0.3.0-preview.4'] }).join(), /already exists|newer than v0.3.0-preview.4/);
  assert.match(validateRelease({ version: '0.3.0-preview.2', channel: 'preview', committedVersion: '0.3.0', existing: ['v0.3.0'] }).join(), /newer than the latest stable/);
});

const asset = (over = {}) => ({ PackageId: 'aiostreams-integrated', Version: '0.3.0', Type: 'Full', FileName: 'aiostreams-integrated-0.3.0-win-x64-full.nupkg', SHA1: 'b'.repeat(40), SHA256: SHA, Size: 10, NotesMarkdown: '', NotesHtml: '', ...over });
const feed = (...assets) => JSON.stringify({ Assets: assets });

test('a correct feed passes, with or without the package files', () => {
  assert.deepEqual(verifyFeed(feed(asset(), asset({ Version: '0.2.2', FileName: 'aiostreams-integrated-0.2.2-win-x64-full.nupkg' })), { version: '0.3.0' }), []);
  assert.deepEqual(verifyFeed(feed(asset()), { version: '0.3.0', files: { 'aiostreams-integrated-0.3.0-win-x64-full.nupkg': { size: 10, sha256: SHA } } }), []);
});

test('feeds that could install the wrong app or a tampered package are rejected', () => {
  const errors = (text, options = { version: '0.3.0' }) => verifyFeed(text, options).join(' ');
  assert.match(errors(feed(asset({ PackageId: 'aiostreams-desktop' }))), /never offer another app/);
  assert.match(errors(feed(asset({ FileName: '../evil.nupkg' }))), /unsafe/);
  assert.match(errors(feed(asset({ FileName: 'https://example.com/x.nupkg' }))), /unsafe/);
  assert.match(errors(feed(asset({ SHA256: '' }))), /missing SHA256/);
  assert.match(errors(feed(asset({ Version: '0.2.2' }))), /no full package for 0.3.0/);
  assert.match(errors(feed(asset(), asset({ Version: '9.0.0' }))), /newer than the release/);
  assert.match(errors('{"Assets":[]}'), /no assets/);
  assert.match(errors('not json'), /not JSON/);
  assert.match(errors(feed(asset()), { version: '0.3.0', files: { 'aiostreams-integrated-0.3.0-win-x64-full.nupkg': { size: 10, sha256: 'c'.repeat(64) } } }), /SHA256 does not match/);
  assert.match(errors(feed(asset()), { version: '0.3.0', files: {} }), /not present/);
});

test('checksum files written on Windows parse', () => {
  assert.deepEqual(parseChecksums(`﻿${SHA}  a.exe\r\n${'B'.repeat(64)} *b.zip\r\n`), { 'a.exe': SHA, 'b.zip': 'b'.repeat(64) });
});

test('release-note sections are found by exact version', () => {
  const md = '# Notes\n\n## 0.3.0\n\n- New\n\n## 0.2.2\n\n- Old\n';
  assert.equal(notesSection(md, '0.3.0'), '- New');
  assert.equal(notesSection(md, '0.2.2'), '- Old');
  assert.equal(notesSection(md, '0.3'), null);
});

test('release notes carry versions, attribution, warnings and checksums', () => {
  const text = renderReleaseNotes({
    version: '0.3.0-preview.1', channel: 'preview', repository: 'o/r', commit: 'c'.repeat(40), runId: '1',
    upstream: { ref: 'desktop-v0.25.0', commit: 'd'.repeat(40), serverVersion: '2.38.0', desktopVersion: '0.25.0', changelogs: ['https://x/desktop-v0.25.0'] },
    previousUpstream: { ref: 'desktop-v0.24.0', commit: 'e'.repeat(40), serverVersion: '2.37.0', desktopVersion: '0.24.0' },
    notes: '- Updates', migrations: ['packages/core/src/db/migrations/0006_x.ts'], signed: false,
    files: { setup: 's.exe', portable: 'p.zip', source: 'src.tar.gz' }, checksums: `${SHA}  s.exe\n`,
  });
  for (const expected of [/unofficial/, /Viren070/, /Preview build/, /2\.38\.0/, /0\.25\.0/, /desktop-v0\.24\.0/, /0006_x\.ts/, /unsigned/, /AGPL-3\.0-only/, new RegExp(SHA)]) assert.match(text, expected);
});

test('stable releases join the preview feed unless preview is already ahead', () => {
  const stable = feed(asset(), asset({ Type: 'Delta', FileName: 'aiostreams-integrated-0.3.0-win-x64-delta.nupkg' }));
  const preview = feed(asset({ Version: '0.3.0-preview.2', FileName: 'p2.nupkg' }));
  const merged = JSON.parse(mergeFeed(preview, stable, '0.3.0'));
  assert.deepEqual(merged.Assets.map((a) => a.FileName), ['p2.nupkg', 'aiostreams-integrated-0.3.0-win-x64-full.nupkg']);
  assert.deepEqual(verifyFeed(JSON.stringify(merged), { version: '0.3.0' }), []);
  assert.equal(mergeFeed(feed(asset({ Version: '0.3.1-preview.1', FileName: 'p.nupkg' })), stable, '0.3.0'), null);
  assert.ok(JSON.parse(mergeFeed('', stable, '0.3.0')).Assets.length === 1);
});
