#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Upstream synchronisation for AIOStreams Integrated. See docs/UPSTREAM-SYNC.md.
//
//   node scripts/upstream/sync.mjs detect [--ref <tag>]
//       Finds the newest stable upstream release and says whether it is newer
//       than .github/upstream-sync.json's baseline. Prints JSON.
//   node scripts/upstream/sync.mjs prepare [--ref <tag>] [--out <dir>]
//       Merges that release into a new local branch upstream-sync/<tag> made
//       from the current HEAD, updates the tracking files and writes the PR
//       description to <dir>/report.md and the outcome to <dir>/result.json.
//       Conflicts are committed with their markers (never resolved by guessing).
//   node scripts/upstream/sync.mjs report --target <commit> [--out <dir>]
//       Only writes the report for HEAD's baseline against <commit>.
//   node scripts/upstream/sync.mjs check-markers
//   node scripts/upstream/sync.mjs check-guards
//       Repository checks run by Pull Request CI.
//
// Never pushes, never touches main and never deletes anything: the workflow
// pushes the branch it prepared.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chooseTarget,
  classifyChanges,
  groupCommits,
  hasConflictMarkers,
  latestTags,
  parseReleaseTags,
  releaseLinks,
  renderReport,
  versionsFromManifest,
} from './lib.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const trackingPath = path.join(repo, '.github/upstream-sync.json');
const hooksPath = path.join(repo, 'scripts/upstream/hooks.json');
const manifestPath = path.join(repo, 'SOURCE-MANIFEST.json');
const REMOTE = 'upstream';

const args = process.argv.slice(2);
const command = args[0];
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

function git(argv, options = {}) {
  return execFileSync('git', argv, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', options.quiet ? 'ignore' : 'inherit'], ...options }).trim();
}
function gitOk(argv) {
  try {
    execFileSync('git', argv, { cwd: repo, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const tracking = () => readJson(trackingPath);
const hooks = () => readJson(hooksPath);

function ensureRemote(url) {
  // Tests point the remote at a local repository; production uses the tracked URL.
  url = process.env.UPSTREAM_SYNC_TEST_REMOTE ?? url;
  const existing = gitOk(['remote', 'get-url', REMOTE]) ? git(['remote', 'get-url', REMOTE]) : null;
  if (existing === null) git(['remote', 'add', REMOTE, url]);
  else if (existing.replace(/\.git$/, '') !== url.replace(/\.git$/, '')) {
    throw new Error(`Remote '${REMOTE}' points at ${existing}, expected ${url}`);
  }
}

/** Fetches a commit and enough history to merge it; unshallows if needed. */
function fetchCommit(sha) {
  if (gitOk(['cat-file', '-e', `${sha}^{commit}`]) && git(['rev-parse', '--is-shallow-repository']) === 'false') return;
  if (git(['rev-parse', '--is-shallow-repository']) === 'true') git(['fetch', '--unshallow', '--no-tags', 'origin']);
  git(['fetch', '--no-tags', REMOTE, sha]);
}

function detect() {
  const config = tracking();
  const { upstream, baseline } = config;
  if (upstream.channel !== 'stable') {
    // Only stable is implemented; a different value is a deliberate edit that must not be guessed at.
    throw new Error(`Unsupported upstream channel '${upstream.channel}'. Only 'stable' is supported.`);
  }
  ensureRemote(upstream.repository + '.git');
  const tags = parseReleaseTags(git(['ls-remote', '--tags', REMOTE]), upstream);
  let target;
  const ref = option('--ref');
  if (ref) {
    target = tags.find((tag) => tag.name === ref);
    if (!target) throw new Error(`${ref} is not a stable upstream server or desktop release tag`);
  } else {
    const latest = latestTags(tags, config.blocked ?? []);
    for (const tag of Object.values(latest)) fetchCommit(tag.commit);
    target = chooseTarget(
      latest,
      (a, b) => gitOk(['merge-base', '--is-ancestor', a, b]),
      (sha) => Number(git(['log', '-1', '--format=%ct', sha])),
    );
  }
  if (!target) throw new Error('No stable upstream release tags found');
  fetchCommit(target.commit);
  const versions = versionsFromManifest(git(['show', `${target.commit}:.release-please-manifest.json`]));
  const result = {
    target: {
      ref: target.name,
      commit: target.commit,
      commitTime: new Date(Number(git(['log', '-1', '--format=%ct', target.commit])) * 1000).toISOString().replace('.000Z', 'Z'),
      ...versions,
    },
    baseline,
    blocked: (config.blocked ?? []).map((entry) => entry.ref),
    tags,
  };
  const integrated = target.commit === baseline.commit || gitOk(['merge-base', '--is-ancestor', target.commit, baseline.commit]);
  result.status = integrated ? 'up-to-date' : 'available';
  result.branch = `upstream-sync/${target.name}`;
  return result;
}

function buildReport(baseline, target, conflicts, tags) {
  const config = tracking();
  const files = git(['diff', '--name-only', baseline.commit, target.commit]).split('\n').filter(Boolean);
  const subjects = git(['log', '--no-merges', '--format=%s', `${baseline.commit}..${target.commit}`]).split('\n').filter(Boolean);
  const bridge = 'packages/desktop/core/src/bridge.rs';
  const bridgeDiff = files.includes(bridge) ? git(['diff', baseline.commit, target.commit, '--', bridge]) : '';
  const nodeOf = (sha) => /FROM node:([\d.]+)/.exec(gitOk(['cat-file', '-e', `${sha}:Dockerfile`]) ? git(['show', `${sha}:Dockerfile`]) : '')?.[1];
  const [nodeBefore, nodeAfter] = [nodeOf(baseline.commit), nodeOf(target.commit)];
  return renderReport({
    repository: config.upstream.repository,
    baseline,
    target,
    conflicts,
    hooks: hooks(),
    classification: classifyChanges(files, hooks()),
    commits: groupCommits(subjects),
    commitCount: subjects.length,
    releases: releaseLinks(tags, baseline, target, config.upstream.repository),
    protocolChanged: /^[-+]pub const PROTOCOL_VERSION/m.test(bridgeDiff),
    nodeChange: nodeBefore && nodeAfter && nodeBefore !== nodeAfter ? `${nodeBefore} → ${nodeAfter}` : null,
  });
}

function writeOut(dir, report, result) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.md'), report);
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
}

function prepare() {
  if (git(['status', '--porcelain'])) throw new Error('The working tree has changes; prepare needs a clean checkout.');
  const found = detect();
  const out = path.resolve(option('--out') ?? path.join(repo, '.upstream-sync'));
  if (found.status === 'up-to-date') {
    const result = { status: 'up-to-date', target: found.target, baseline: found.baseline };
    writeOut(out, '', result);
    return result;
  }
  const { target, baseline } = found;
  const base = git(['rev-parse', 'HEAD']);
  git(['checkout', '-B', found.branch, base], { quiet: true });
  const title = `chore(upstream): sync AIOStreams server ${target.serverVersion} and desktop ${target.desktopVersion} (${target.ref})`;
  let conflicts = [];
  if (!gitOk(['merge', '--no-ff', '--no-commit', '--no-edit', target.commit])) {
    conflicts = git(['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
    if (conflicts.length === 0) {
      git(['merge', '--abort']);
      throw new Error('git merge failed without reporting conflicted files');
    }
  }
  // Tracking files describe what this branch integrates.
  const config = tracking();
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  config.baseline = {
    ref: target.ref,
    commit: target.commit,
    commitTime: target.commitTime,
    serverVersion: target.serverVersion,
    desktopVersion: target.desktopVersion,
    integratedAt: now,
    status: conflicts.length ? 'conflicted' : 'integrated',
    changelogs: releaseLinks(found.tags, baseline, target, config.upstream.repository).map((link) => link.url),
  };
  config.previous = { ref: baseline.ref, commit: baseline.commit, serverVersion: baseline.serverVersion, desktopVersion: baseline.desktopVersion };
  fs.writeFileSync(trackingPath, JSON.stringify(config, null, 2) + '\n');
  if (fs.existsSync(manifestPath)) {
    const manifest = readJson(manifestPath);
    Object.assign(manifest, { upstreamCommit: target.commit, upstreamCommitTime: target.commitTime });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
  git(['add', '-A']);
  const body = [
    `Merges upstream ${target.ref} (${target.commit}) into the integrated app.`,
    `Previous upstream baseline: ${baseline.ref} (${baseline.commit}).`,
    conflicts.length ? `\nUNRESOLVED CONFLICTS (committed with markers for manual resolution):\n${conflicts.map((f) => `  ${f}`).join('\n')}` : '',
  ].join('\n');
  git(['commit', '--no-verify', '-m', title, '-m', body], { quiet: true });
  const report = buildReport(baseline, target, conflicts, found.tags);
  const result = { status: conflicts.length ? 'conflicted' : 'merged', branch: found.branch, title, base, head: git(['rev-parse', 'HEAD']), conflicts, target, baseline };
  writeOut(out, report, result);
  return result;
}

function checkMarkers() {
  const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
  const bad = [];
  for (const file of files) {
    const full = path.join(repo, file);
    let text;
    try {
      if (fs.statSync(full).size > 8 * 1024 * 1024) continue;
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue;
    if (hasConflictMarkers(text)) bad.push(file);
  }
  if (bad.length) {
    for (const file of bad) console.log(`::error file=${file}::Unresolved merge conflict markers`);
    throw new Error(`${bad.length} file(s) contain conflict markers`);
  }
  console.log(`No conflict markers in ${files.length} tracked files.`);
}

/** Every job in an inherited upstream workflow must be limited to Viren070/AIOStreams. */
export function unguardedJobs(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (start < 0) return [];
  const jobs = [];
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const job = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (job) {
      current = { name: job[1], guarded: false };
      jobs.push(current);
    } else if (current && /^ {4}if:.*github\.repository\s*==\s*'Viren070\/AIOStreams'/.test(line)) {
      current.guarded = true;
    }
  }
  return jobs.filter((job) => !job.guarded).map((job) => job.name);
}

function checkGuards() {
  const owned = new Set(hooks().integrationWorkflows);
  const dir = path.join(repo, '.github/workflows');
  let failures = 0;
  for (const name of fs.readdirSync(dir).filter((file) => /\.ya?ml$/.test(file)).sort()) {
    if (owned.has(name)) continue;
    const missing = unguardedJobs(fs.readFileSync(path.join(dir, name), 'utf8'));
    for (const job of missing) {
      failures++;
      console.log(`::error file=.github/workflows/${name}::Job '${job}' is inherited from upstream but not limited to Viren070/AIOStreams. Add: if: github.repository == 'Viren070/AIOStreams' (or list the file in scripts/upstream/hooks.json integrationWorkflows if this repository owns it).`);
    }
  }
  if (failures) throw new Error(`${failures} unguarded upstream workflow job(s)`);
  console.log('Every inherited upstream workflow job is limited to Viren070/AIOStreams.');
}

function main() {
  switch (command) {
    case 'detect': {
      const result = detect();
      delete result.tags;
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case 'prepare':
      console.log(JSON.stringify(prepare(), null, 2));
      return;
    case 'report': {
      const commit = option('--target');
      if (!commit) throw new Error('--target <commit> is required');
      const config = tracking();
      ensureRemote(config.upstream.repository + '.git');
      fetchCommit(commit);
      const tags = parseReleaseTags(git(['ls-remote', '--tags', REMOTE]), config.upstream);
      const target = { ref: option('--ref') ?? commit.slice(0, 12), commit, ...versionsFromManifest(git(['show', `${commit}:.release-please-manifest.json`])) };
      const report = buildReport(config.baseline, target, [], tags);
      writeOut(path.resolve(option('--out') ?? path.join(repo, '.upstream-sync')), report, { status: 'report', target, baseline: config.baseline });
      console.log(report);
      return;
    }
    case 'check-markers':
      return checkMarkers();
    case 'check-guards':
      return checkGuards();
    default:
      console.error('Usage: sync.mjs detect|prepare|report|check-markers|check-guards');
      process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
