#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Automatic releases for AIOStreams Integrated, run by .github/workflows/auto-release.yml.
// See docs/RELEASE-PROCESS.md, "Automatic releases".
//
//   automerge   merge open upstream-sync / release-bump pull requests whose
//               every check passed (Windows build and tests included)
//   bump        after a stable release, open the pull request that moves
//               integrated-version.json to the next patch version
//   preview     if main has unreleased code, start a Preview build that
//               publishes itself (vX.Y.Z-preview.N)
//   stable      promote the newest Preview to Stable once it has been out for
//               AUTO_STABLE_AFTER_DAYS days (default 3) with no open
//               `release-blocker` issue; --force promotes now
//
// Every decision is a pure function below (tested in auto.test.mjs); the
// commands only gather facts with git and gh, and act on the decision.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { channelOf, compareSemver, parseSemver } from './lib.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Checks that must have passed on a pull request's head before it merges itself. */
export const REQUIRED_CHECKS = {
  // Integrated Windows desktop: the real build, smoke tests, installer, playback and updates.
  'windows-x64': ['success'],
  // Pull Request CI; a job skipped because nothing relevant changed counts as passing.
  'Repository checks': ['success'],
  'TypeScript build and tests': ['success', 'skipped'],
  'Rust tests': ['success', 'skipped'],
};
const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);
/** Pull requests that may merge themselves, by label and branch prefix. */
export const AUTOMERGE = { 'upstream-sync': 'upstream-sync/', 'release-bump': 'release/bump-' };

/** Changes that do not alter the shipped app: they never need a new release. */
export function releaseRelevant(file) {
  return !(
    file.endsWith('.md') ||
    file.startsWith('docs/') ||
    file.startsWith('.github/') ||
    file === 'integrated-version.json' ||
    file === 'SOURCE-MANIFEST.json'
  );
}

export function nextPatch(version) {
  const v = parseSemver(version);
  if (!v || v.pre.length) throw new Error(`${version} is not a stable X.Y.Z version`);
  return `${v.major}.${v.minor}.${v.patch + 1}`;
}

/**
 * Whether a pull request may merge itself now.
 * `pr`: { number, headRefName, headRefOid, isDraft, isCrossRepository, mergeStateStatus, labels: [{name}] }
 * `checkRuns`: [{ name, status, conclusion }] for the head commit (latest attempt of each).
 */
export function automergeDecision(pr, checkRuns) {
  const label = Object.keys(AUTOMERGE).find((name) => pr.labels.some((l) => l.name === name));
  if (!label) return { merge: false, reason: 'not an automatic pull request' };
  if (!pr.headRefName.startsWith(AUTOMERGE[label])) return { merge: false, reason: `branch ${pr.headRefName} does not start with ${AUTOMERGE[label]}` };
  if (pr.isCrossRepository) return { merge: false, reason: 'opened from a fork' };
  if (pr.isDraft) return { merge: false, reason: 'draft (an upstream merge with conflicts waits for a person)' };
  const pending = checkRuns.filter((run) => run.status !== 'completed').map((run) => run.name);
  if (pending.length) return { merge: false, reason: `waiting for ${pending.join(', ')}`, waiting: true };
  const failed = checkRuns.filter((run) => FAILED.has(run.conclusion)).map((run) => `${run.name} (${run.conclusion})`);
  if (failed.length) return { merge: false, reason: `failed: ${failed.join(', ')}` };
  for (const [name, ok] of Object.entries(REQUIRED_CHECKS)) {
    const run = checkRuns.find((r) => r.name === name);
    if (!run) return { merge: false, reason: `waiting for ${name} to run`, waiting: true };
    if (!ok.includes(run.conclusion)) return { merge: false, reason: `${name} ended ${run.conclusion}` };
  }
  // Behind main where branch protection requires up-to-date branches: bring it
  // up to date; its checks then run again on the new head.
  if (pr.mergeStateStatus === 'BEHIND') return { merge: false, update: true, reason: 'behind main; updating the branch' };
  if (pr.mergeStateStatus !== 'CLEAN') return { merge: false, reason: `merge state ${pr.mergeStateStatus}`, waiting: pr.mergeStateStatus === 'UNKNOWN' };
  return { merge: true, reason: `every check passed on ${pr.headRefOid.slice(0, 12)}` };
}

/** Whether integrated-version.json has already shipped as stable and must move on. */
export function bumpDecision({ committed, publishedTags }) {
  if (!publishedTags.includes(`v${committed}`)) return { bump: false, reason: `${committed} is not released yet` };
  return { bump: true, version: nextPatch(committed), reason: `${committed} is released; the next version is ${nextPatch(committed)}` };
}

/**
 * The Preview to build now, if any.
 * `existingTags`: every release tag including drafts. `changedSinceRelease`:
 * release-relevant files changed since the newest published release (null if
 * there has never been one).
 */
export function previewDecision({ committed, existingTags, publishedTags, changedSinceRelease, buildRunning }) {
  if (publishedTags.includes(`v${committed}`)) return { action: 'none', reason: `${committed} is already stable; waiting for the version bump` };
  if (buildRunning) return { action: 'none', reason: 'a release build is already running' };
  if (changedSinceRelease !== null && changedSinceRelease.length === 0) return { action: 'none', reason: 'nothing to release since the last release' };
  const numbers = existingTags
    .map((tag) => tag.replace(/^v/, ''))
    .filter((v) => channelOf(v) === 'preview' && v.startsWith(`${committed}-preview.`))
    .map((v) => Number(v.slice(`${committed}-preview.`.length)));
  const version = `${committed}-preview.${Math.max(0, ...numbers) + 1}`;
  const what = changedSinceRelease === null ? 'first release' : `${changedSinceRelease.length} changed file(s)`;
  return { action: 'release', version, reason: `${what} since the last release` };
}

/**
 * Whether to promote the newest published Preview to Stable.
 * `previews`: [{ version, publishedAt }] published previews. `days`: number or
 * null (automatic promotion off). `changedSincePreview`: release-relevant files
 * on main that the preview does not contain.
 */
export function stableDecision({ previews, existingTags, days, now, force, blockers, changedSincePreview, buildRunning }) {
  const newest = [...previews].sort((a, b) => compareSemver(a.version, b.version)).at(-1);
  if (!newest) return { promote: false, reason: 'no published preview' };
  const version = newest.version.replace(/-preview\.\d+$/, '');
  if (existingTags.includes(`v${version}`)) return { promote: false, reason: `v${version} already exists` };
  if (buildRunning) return { promote: false, reason: 'a release build is already running' };
  if (blockers > 0) return { promote: false, reason: `${blockers} open release-blocker issue(s)` };
  if (changedSincePreview.length) {
    return { promote: false, reason: `main has changes v${newest.version} does not contain; a newer preview comes first` };
  }
  if (!force) {
    if (days === null) return { promote: false, reason: 'automatic promotion is off; run Auto release with promote' };
    const age = (now - Date.parse(newest.publishedAt)) / 86400000;
    if (age < days) return { promote: false, reason: `v${newest.version} has been out ${age.toFixed(1)} of ${days} days` };
  }
  return { promote: true, version, from: newest.version, reason: `promoting v${newest.version}` };
}

/** Inserts the release-notes section a bumped version needs (release.mjs check). */
export function addNotesSection(markdown, version, previous) {
  if (new RegExp(`^## ${version.replace(/\./g, '\\.')}\\b`, 'm').test(markdown)) return markdown;
  const section = `## ${version}\n\nAutomatic release after ${previous}: upstream AIOStreams and AIOMetadata updates and fixes. The release page lists the upstream changes.\n\n`;
  const first = markdown.search(/^## /m);
  return first < 0 ? `${markdown.trimEnd()}\n\n${section}` : markdown.slice(0, first) + section + markdown.slice(first);
}

// ---------------------------------------------------------------- facts

const gh = (...args) => execFileSync('gh', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const committedVersion = () => JSON.parse(fs.readFileSync(path.join(repo, 'integrated-version.json'), 'utf8')).version;
const isReleaseTag = (tag) => /^v\d+\.\d+\.\d+(-preview\.[1-9]\d*)?$/.test(tag);

function releases() {
  const list = JSON.parse(gh('release', 'list', '--limit', '200', '--json', 'tagName,isDraft,isPrerelease,publishedAt'));
  const all = list.filter((r) => isReleaseTag(r.tagName));
  const published = all.filter((r) => !r.isDraft);
  return {
    existingTags: all.map((r) => r.tagName),
    publishedTags: published.map((r) => r.tagName),
    previews: published.filter((r) => channelOf(r.tagName.slice(1)) === 'preview')
      .map((r) => ({ version: r.tagName.slice(1), publishedAt: r.publishedAt })),
  };
}

/** Release-relevant files that differ between a published tag and HEAD. */
function changedSince(tag) {
  git('fetch', '--quiet', '--force', 'origin', `refs/tags/${tag}:refs/tags/${tag}`);
  return git('diff', '--name-only', `${tag}`, 'HEAD').split('\n').filter(Boolean).filter(releaseRelevant);
}

function buildRunning() {
  const runs = JSON.parse(gh('run', 'list', '--workflow', 'embedded-desktop.yml', '--branch', 'main', '--event', 'workflow_dispatch',
    '--limit', '20', '--json', 'status'));
  return runs.some((run) => run.status !== 'completed');
}

function dispatchRelease(version, channel) {
  gh('workflow', 'run', 'embedded-desktop.yml', '--ref', 'main',
    '-f', `version=${version}`, '-f', `channel=${channel}`, '-f', 'draft_release=true', '-f', 'publish=true');
}

function summary(line) {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

// ---------------------------------------------------------------- commands

function automerge() {
  let merged = 0;
  for (const label of Object.keys(AUTOMERGE)) {
    const prs = JSON.parse(gh('pr', 'list', '--state', 'open', '--label', label, '--json',
      'number,headRefName,headRefOid,isDraft,isCrossRepository,mergeStateStatus,labels'));
    for (const pr of prs) {
      const runs = JSON.parse(gh('api', `repos/{owner}/{repo}/commits/${pr.headRefOid}/check-runs?per_page=100`, '--jq', '[.check_runs[] | {name, status, conclusion, id}]'));
      // A re-run leaves the earlier attempt behind; judge each check by its latest run.
      const latest = Object.values(Object.fromEntries(runs.sort((a, b) => a.id - b.id).map((r) => [r.name, r])));
      const decision = automergeDecision(pr, latest);
      summary(`- #${pr.number} (${pr.headRefName}): ${decision.merge ? 'merging' : 'not merging'}, ${decision.reason}`);
      if (decision.update) {
        gh('pr', 'update-branch', String(pr.number));
        if (process.env.USING_APP !== 'true') {
          // A push with GITHUB_TOKEN starts no workflows; run the checks on the new head.
          gh('workflow', 'run', 'pr-ci.yml', '--ref', pr.headRefName);
          gh('workflow', 'run', 'embedded-desktop.yml', '--ref', pr.headRefName);
        }
        continue;
      }
      if (!decision.merge) continue;
      try {
        gh('pr', 'merge', String(pr.number), '--merge', '--match-head-commit', pr.headRefOid);
        merged++;
      } catch {
        summary(`  ::warning::#${pr.number} could not be merged (branch protection may require an approval); it waits for a person.`);
      }
    }
  }
  if (merged) git('pull', '--quiet', '--ff-only', 'origin', 'main');
}

function bump() {
  const committed = committedVersion();
  const decision = bumpDecision({ committed, publishedTags: releases().publishedTags });
  summary(`Version: ${decision.reason}.`);
  if (!decision.bump) return;
  const branch = `release/bump-${decision.version}`;
  if (git('ls-remote', '--heads', 'origin', branch)) return summary(`Pull request branch ${branch} already exists.`);
  git('switch', '-c', branch);
  fs.writeFileSync(path.join(repo, 'integrated-version.json'),
    fs.readFileSync(path.join(repo, 'integrated-version.json'), 'utf8').replace(`"${committed}"`, `"${decision.version}"`));
  const notesPath = path.join(repo, 'RELEASE-NOTES.md');
  fs.writeFileSync(notesPath, addNotesSection(fs.readFileSync(notesPath, 'utf8'), decision.version, committed));
  git('-c', 'user.name=aiostreams-integrated-release[bot]', '-c', 'user.email=aiostreams-integrated-release@users.noreply.github.com',
    'commit', '--quiet', '-am', `chore(release): start ${decision.version}`);
  git('push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
  try { gh('label', 'create', 'release-bump', '--color', '1d76db', '--description', 'Automatic version bump after a stable release'); } catch { /* exists */ }
  gh('pr', 'create', '--base', 'main', '--head', branch, '--label', 'release-bump', '--title', `chore(release): start ${decision.version}`,
    '--body', `v${committed} is released as Stable, so \`integrated-version.json\` moves to the next version, ${decision.version}, and RELEASE-NOTES.md gets its section.\n\nOpened by **Auto release**; it merges itself when its checks pass.`);
  if (process.env.USING_APP !== 'true') {
    // Pull requests opened with GITHUB_TOKEN start no pull_request workflows.
    gh('workflow', 'run', 'pr-ci.yml', '--ref', branch);
    gh('workflow', 'run', 'embedded-desktop.yml', '--ref', branch);
  }
  git('switch', '--quiet', 'main');
}

function preview() {
  const committed = committedVersion();
  const facts = releases();
  const newest = [...facts.publishedTags].sort((a, b) => compareSemver(a.slice(1), b.slice(1))).at(-1);
  const decision = previewDecision({
    committed,
    existingTags: facts.existingTags,
    publishedTags: facts.publishedTags,
    changedSinceRelease: newest ? changedSince(newest) : null,
    buildRunning: buildRunning(),
  });
  summary(`Preview: ${decision.action === 'release' ? `building v${decision.version}` : 'nothing to do'}, ${decision.reason}.`);
  if (decision.action === 'release') dispatchRelease(decision.version, 'preview');
}

function stable() {
  const facts = releases();
  const raw = (process.env.AUTO_STABLE_AFTER_DAYS ?? '3').trim();
  const days = raw === 'off' ? null : Number(raw);
  if (days !== null && !(days >= 0)) throw new Error(`AUTO_STABLE_AFTER_DAYS must be a number of days or 'off', not '${raw}'`);
  const newest = [...facts.previews].sort((a, b) => compareSemver(a.version, b.version)).at(-1);
  const decision = stableDecision({
    ...facts,
    days,
    now: Date.now(),
    force: process.argv.includes('--force'),
    blockers: JSON.parse(gh('issue', 'list', '--state', 'open', '--label', 'release-blocker', '--json', 'number')).length,
    changedSincePreview: newest ? changedSince(`v${newest.version}`) : [],
    buildRunning: buildRunning(),
  });
  summary(`Stable: ${decision.promote ? `building v${decision.version}` : 'not now'}, ${decision.reason}.`);
  if (decision.promote) dispatchRelease(decision.version, 'stable');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const run = { automerge, bump, preview, stable }[process.argv[2]];
  if (!run) {
    console.error('Usage: node scripts/release/auto.mjs automerge | bump | preview | stable [--force]');
    process.exit(2);
  }
  try {
    run();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
