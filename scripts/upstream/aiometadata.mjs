// SPDX-License-Identifier: AGPL-3.0-only
// Keeps the bundled AIOMetadata (scripts/desktop/runtime-pins.json) on its
// newest stable release. Used by the daily Upstream Sync workflow:
//
//   node scripts/upstream/aiometadata.mjs detect
//     → JSON {status: "current"|"available", current, target, branch}
//   node scripts/upstream/aiometadata.mjs prepare --tag vX.Y.Z --out <dir>
//     → updates the pin and the docs that name the version, writes
//       <dir>/result.json and <dir>/report.md for the pull request
//
// "Newest" is the release AIOMetadata's author marks Latest on GitHub, not the
// highest tag: the repository carries an old v5.0.0 tag that predates 4.x.
// The release must also be newer (SemVer) and published after the pinned one,
// and its tag must resolve to a commit whose package.json has that version.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pinsPath = path.join(repo, 'scripts/desktop/runtime-pins.json');
const API = 'https://api.github.com/repos/cedya77/aiometadata';
const RAW = 'https://raw.githubusercontent.com/cedya77/aiometadata';
/** Files that name the pinned version or commit, besides runtime-pins.json. */
export const VERSIONED_DOCS = ['docs/embedded-third-party.md'];

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function compare(a, b) {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) throw new Error(`Not a stable version: ${!x ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return Math.sign(d);
  }
  return 0;
}

/**
 * Decides whether `latest` (GitHub's latest-release object) should replace the
 * pin. `pinnedPublishedAt` is when the pinned release was published, if known.
 * Returns { status, reason, target? }.
 */
export function chooseUpdate({ pin, latest, pinnedPublishedAt }) {
  if (!latest || latest.draft || latest.prerelease) return { status: 'current', reason: 'No published stable release.' };
  const tag = latest.tag_name;
  const version = /^v(\d+\.\d+\.\d+)$/.exec(tag ?? '')?.[1];
  if (!version) return { status: 'current', reason: `Latest release ${tag} is not a vX.Y.Z tag.` };
  if (compare(version, pin.version) <= 0) return { status: 'current', reason: `AIOMetadata ${pin.version} is current (latest ${version}).` };
  if (pinnedPublishedAt && Date.parse(latest.published_at) <= Date.parse(pinnedPublishedAt)) {
    return { status: 'current', reason: `Release ${tag} is not newer than the pinned ${pin.tag}.` };
  }
  return {
    status: 'available',
    reason: `AIOMetadata ${version} is available (pinned ${pin.version}).`,
    target: { version, tag, url: latest.html_url, publishedAt: latest.published_at },
  };
}

/** The commit a tag points to, from `git ls-remote` output (peeled tags win). */
export function tagCommit(lsRemote, tag) {
  let direct;
  for (const line of lsRemote.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (ref === `refs/tags/${tag}^{}`) return sha;
    if (ref === `refs/tags/${tag}`) direct = sha;
  }
  if (!direct) throw new Error(`Tag ${tag} not found`);
  return direct;
}

/** Rewrites the version, source-archive name and short commit in a document. */
export function rewriteDoc(text, from, to) {
  return text
    .split(`AIOMetadata ${from.version}`).join(`AIOMetadata ${to.version}`)
    .split(`aiometadata-${from.version}-source`).join(`aiometadata-${to.version}-source`)
    .split(`\`${from.commit.slice(0, 8)}\``).join(`\`${to.commit.slice(0, 8)}\``);
}

async function github(url) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'aiostreams-integrated-sync' };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const response = await fetch(url, { headers });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return response.json();
}

const readPins = () => JSON.parse(fs.readFileSync(pinsPath, 'utf8'));
const arg = (name) => {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`Missing ${name}`);
  return process.argv[i + 1];
};

async function detect() {
  const pin = readPins().aiometadata;
  const [latest, pinned] = await Promise.all([
    github(`${API}/releases/latest`),
    github(`${API}/releases/tags/${pin.tag}`),
  ]);
  const decision = chooseUpdate({ pin, latest, pinnedPublishedAt: pinned?.published_at });
  const out = { ...decision, current: { version: pin.version, tag: pin.tag, commit: pin.commit } };
  if (decision.target) out.branch = `upstream-sync/aiometadata-${decision.target.tag}`;
  console.log(JSON.stringify(out, null, 2));
}

async function prepare() {
  const tag = arg('--tag');
  const out = path.resolve(arg('--out'));
  const version = /^v(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
  if (!version) throw new Error(`${tag} is not a vX.Y.Z tag`);
  const pins = readPins();
  const from = pins.aiometadata;
  const commit = tagCommit(
    execFileSync('git', ['ls-remote', '--tags', from.repository, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { encoding: 'utf8' }),
    tag,
  );
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Tag ${tag} resolved to '${commit}'`);
  const pkg = await (await fetch(`${RAW}/${commit}/package.json`)).json();
  if (pkg.version !== version) throw new Error(`${tag} (${commit}) has package.json version ${pkg.version}, not ${version}`);
  // Notes only; the pin itself never depends on this request.
  const release = await github(`${API}/releases/tags/${tag}`).catch(() => null);

  const to = { ...from, version, tag, commit };
  pins.aiometadata = to;
  fs.writeFileSync(pinsPath, JSON.stringify(pins, null, 2) + '\n');
  const changed = ['scripts/desktop/runtime-pins.json'];
  for (const doc of VERSIONED_DOCS) {
    const file = path.join(repo, doc);
    const before = fs.readFileSync(file, 'utf8');
    const after = rewriteDoc(before, from, to);
    if (after !== before) {
      fs.writeFileSync(file, after);
      changed.push(doc);
    }
  }

  fs.mkdirSync(out, { recursive: true });
  const notes = (release?.body ?? '').trim();
  const report = [
    `Bundled AIOMetadata **${from.version} → ${version}** ([release](${release?.html_url ?? `https://github.com/cedya77/aiometadata/releases/tag/${tag}`}), commit \`${commit.slice(0, 12)}\`).`,
    '',
    'Opened by **Upstream Sync**. The Windows build stages this release, runs the AIOMetadata smoke test (Redis 8 commands, readiness, manifest, configuration page, loopback-only, clean stop) and the supervisor lifecycle test.',
    'With automatic releases on, this pull request merges itself when every check passes and a Preview release follows.',
    '',
    'Check the release notes for a new Redis requirement or new required services. The preload relies on `addon/lib/runtimePaths.js` and fails loudly if it is gone.',
    '',
    `Files: ${changed.map((f) => `\`${f}\``).join(', ')}`,
    '',
    '<details><summary>AIOMetadata release notes</summary>',
    '',
    notes.length > 50000 ? `${notes.slice(0, 50000)}\n\n…truncated` : notes || '_No notes._',
    '',
    '</details>',
  ].join('\n');
  fs.writeFileSync(path.join(out, 'report.md'), report + '\n');
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({
    title: `chore(aiometadata): update bundled AIOMetadata to ${version}`,
    from: from.version,
    to: version,
    commit,
    changed,
  }, null, 2) + '\n');
  console.log(`AIOMetadata pin ${from.version} → ${version} (${commit}).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const command = process.argv[2];
  const run = { detect, prepare }[command];
  if (!run) {
    console.error('Usage: node scripts/upstream/aiometadata.mjs detect | prepare --tag vX.Y.Z --out <dir>');
    process.exit(2);
  }
  run().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
