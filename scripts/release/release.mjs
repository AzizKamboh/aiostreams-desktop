#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Release checks and notes for AIOStreams Integrated. See docs/RELEASE-PROCESS.md.
//
//   check                                  versions agree across the repository (PR CI)
//   validate --version V --channel C --existing tags.txt
//   verify-checksums --dir D               every file is listed in SHA256SUMS.txt and matches
//   verify-feed --dir D --version V --channel C [--metadata-only]
//   check-forward --feed releases.json --version V
//   merge-feed --base preview.json --add stable.json --version V --out merged.json
//   notes --version V --channel C --commit SHA --run ID --repository O/R --dir D [--previous-tag T]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANNELS, PACKAGE_ID, channelOf, compareSemver, mergeFeed, notesSection, parseChecksums, renderReleaseNotes, validateRelease, verifyFeed } from './lib.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const required = (name) => option(name) ?? fail(`${name} is required`);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}
function report(errors, ok) {
  if (errors.length) {
    for (const error of errors) console.error(`::error::${error}`);
    process.exit(1);
  }
  console.log(ok);
}
const committedVersion = () => readJson(path.join(repo, 'integrated-version.json')).version;

function hashFile(file) {
  const sha256 = createHash('sha256');
  const sha1 = createHash('sha1');
  const data = fs.readFileSync(file);
  sha256.update(data);
  sha1.update(data);
  return { size: data.length, sha256: sha256.digest('hex'), sha1: sha1.digest('hex') };
}

function check() {
  const errors = [];
  const version = committedVersion();
  if (channelOf(version) !== 'stable') errors.push(`integrated-version.json must hold the next stable X.Y.Z, found '${version}'.`);
  const tracking = readJson(path.join(repo, '.github/upstream-sync.json'));
  const manifest = readJson(path.join(repo, '.release-please-manifest.json'));
  const pkg = readJson(path.join(repo, 'package.json'));
  const cargo = /\[workspace\.package\][^[]*?\nversion\s*=\s*"([^"]+)"/.exec(fs.readFileSync(path.join(repo, 'packages/desktop/Cargo.toml'), 'utf8'))?.[1];
  const { baseline } = tracking;
  if (baseline.status === 'integrated') {
    if (manifest['.'] !== baseline.serverVersion) errors.push(`Upstream server version: tracking says ${baseline.serverVersion}, .release-please-manifest.json says ${manifest['.']}.`);
    if (pkg.version !== baseline.serverVersion) errors.push(`package.json version ${pkg.version} is not the upstream server version ${baseline.serverVersion}; never use it for the integrated version.`);
    if (manifest['packages/desktop'] !== baseline.desktopVersion) errors.push(`Upstream desktop version: tracking says ${baseline.desktopVersion}, manifest says ${manifest['packages/desktop']}.`);
    if (cargo !== baseline.desktopVersion) errors.push(`packages/desktop/Cargo.toml version ${cargo} is not the upstream desktop version ${baseline.desktopVersion}.`);
  }
  if (!/^[0-9a-f]{40}$/.test(baseline.commit)) errors.push('The tracked upstream commit is not a full SHA.');
  const lockVersion = (file, name) => new RegExp(`name = "${name}"\\nversion = "([^"]+)"`).exec(fs.readFileSync(path.join(repo, file), 'utf8'))?.[1];
  const appVelopack = lockVersion('packages/desktop/Cargo.lock', 'velopack');
  const checkVelopack = lockVersion('scripts/release/feed-check/Cargo.lock', 'velopack');
  if (appVelopack !== checkVelopack) errors.push(`feed-check uses Velopack ${checkVelopack} but the app uses ${appVelopack}; update scripts/release/feed-check.`);
  const notes = fs.readFileSync(path.join(repo, 'RELEASE-NOTES.md'), 'utf8');
  if (notesSection(notes, version) === null) errors.push(`RELEASE-NOTES.md has no "## ${version}" section for the version in integrated-version.json.`);
  report(errors, `Integrated ${version}; upstream server ${baseline.serverVersion}, desktop ${baseline.desktopVersion} (${baseline.ref}).`);
}

function validate() {
  const existing = fs.readFileSync(required('--existing'), 'utf8').split(/\s+/).filter(Boolean);
  const version = required('--version');
  report(validateRelease({ version, channel: required('--channel'), committedVersion: committedVersion(), existing }), `v${version} can be released.`);
}

function verifyChecksums() {
  const dir = required('--dir');
  const sums = parseChecksums(fs.readFileSync(path.join(dir, 'SHA256SUMS.txt'), 'utf8'));
  const errors = [];
  const present = fs.readdirSync(dir).filter((name) => name !== 'SHA256SUMS.txt' && fs.statSync(path.join(dir, name)).isFile());
  for (const name of present) {
    if (!sums[name]) errors.push(`${name} is not listed in SHA256SUMS.txt.`);
    else if (hashFile(path.join(dir, name)).sha256 !== sums[name]) errors.push(`${name} does not match SHA256SUMS.txt.`);
  }
  for (const name of Object.keys(sums)) if (!present.includes(name)) errors.push(`${name} is listed in SHA256SUMS.txt but missing.`);
  report(errors, `${present.length} files match SHA256SUMS.txt.`);
}

function verifyFeedCommand() {
  const dir = required('--dir');
  const version = required('--version');
  const channel = CHANNELS[required('--channel')] ?? fail('Unknown channel');
  const feedFile = path.join(dir, `releases.${channel.velopack}.json`);
  if (!fs.existsSync(feedFile)) fail(`${path.basename(feedFile)} is missing: this is not a Velopack feed for ${channel.velopack}.`);
  let files;
  if (!args.includes('--metadata-only')) {
    files = {};
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.nupkg'))) files[name] = hashFile(path.join(dir, name));
  }
  report(verifyFeed(fs.readFileSync(feedFile, 'utf8'), { packageId: PACKAGE_ID, version, files }), `releases.${channel.velopack}.json offers ${PACKAGE_ID} ${version}${files ? ' and its packages match' : ''}.`);
}

function gitShow(ref, file) {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function notes() {
  const version = required('--version');
  const channel = required('--channel');
  const dir = required('--dir');
  const previousTag = option('--previous-tag');
  const tracking = readJson(path.join(repo, '.github/upstream-sync.json'));
  const previousTracking = previousTag ? gitShow(previousTag, '.github/upstream-sync.json') : null;
  // Releases before upstream tracking existed integrated desktop-v0.24.0.
  const previousUpstream = previousTracking ? JSON.parse(previousTracking).baseline : previousTag ? { ref: 'desktop-v0.24.0', commit: '76a5d6da6d1babf885c7f65a2e19bbd55401a26d', serverVersion: '2.37.0', desktopVersion: '0.24.0' } : null;
  let migrations = [];
  if (previousTag) {
    try {
      migrations = execFileSync('git', ['diff', '--name-only', '--diff-filter=A', previousTag, 'HEAD', '--', 'packages/core/src/db/migrations/'], { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean);
    } catch { /* No previous tag in this checkout. */ }
  }
  const releaseNotes = fs.readFileSync(path.join(repo, 'RELEASE-NOTES.md'), 'utf8');
  const prefix = `aiostreams-integrated-${CHANNELS[channel].velopack}`;
  const text = renderReleaseNotes({
    version,
    channel,
    repository: required('--repository'),
    commit: required('--commit'),
    runId: required('--run'),
    upstream: tracking.baseline,
    previousUpstream,
    notes: notesSection(releaseNotes, version.replace(/-.*$/, '')),
    migrations,
    signed: args.includes('--signed'),
    files: { setup: `${prefix}-Setup.exe`, portable: `${prefix}-Portable.zip`, source: 'aiostreams-integrated-source.tar.gz' },
    checksums: fs.readFileSync(path.join(dir, 'SHA256SUMS.txt'), 'utf8').replace(/^﻿/, '').replace(/\r/g, ''),
  });
  process.stdout.write(text);
}

function mergeFeedCommand() {
  const basePath = option('--base');
  const base = basePath && fs.existsSync(basePath) ? fs.readFileSync(basePath, 'utf8') : '';
  const merged = mergeFeed(base, fs.readFileSync(required('--add'), 'utf8'), required('--version'));
  if (merged === null) {
    console.log('skip');
    return;
  }
  fs.writeFileSync(required('--out'), merged);
  console.log('merged');
}

/** A feed never moves backwards: the new version must be at least its newest full package. */
function checkForward() {
  const version = required('--version');
  const feed = readJson(required('--feed'));
  const newest = (feed.Assets ?? []).filter((a) => /^full$/i.test(a.Type) && channelOf(a.Version)).map((a) => a.Version).sort(compareSemver).at(-1);
  if (newest && compareSemver(version, newest) < 0) fail(`The feed already offers ${newest}, newer than ${version}.`);
  console.log(`The feed's newest version is ${newest ?? 'none'}; ${version} moves it forward.`);
}

switch (args[0]) {
  case 'check-forward': checkForward(); break;
  case 'merge-feed': mergeFeedCommand(); break;
  case 'check': check(); break;
  case 'validate': validate(); break;
  case 'verify-checksums': verifyChecksums(); break;
  case 'verify-feed': verifyFeedCommand(); break;
  case 'notes': notes(); break;
  default:
    console.error('Usage: release.mjs check|validate|verify-checksums|verify-feed|notes');
    process.exit(2);
}
