#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Proposes updates to pins this repository owns. Upstream's dependencies
// (package.json, pnpm-lock.yaml, Cargo.lock) arrive with upstream syncs and
// are deliberately not touched here, so syncs do not conflict.
//
//   node scripts/release/deps.mjs [--write]
//
// - Node.js: newest 24.x patch (same major as upstream's engines), with the
//   official SHA-256 of the Windows x64 ZIP, in runtime-pins.json and the
//   integration workflows' node-version.
// - GitHub Actions used by integration-owned workflows: newest release of the
//   same major version, pinned by commit SHA.
// - Velopack's vpk CLI: reported only (kept equal to upstream's choice).
// Prints a Markdown summary; with --write, edits the files.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareSemver, parseSemver } from './lib.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const write = process.argv.includes('--write');
const pinsPath = path.join(repo, 'scripts/desktop/runtime-pins.json');
const pins = JSON.parse(fs.readFileSync(pinsPath, 'utf8'));
const hooks = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/upstream/hooks.json'), 'utf8'));
const workflows = hooks.integrationWorkflows.map((name) => path.join(repo, '.github/workflows', name)).filter((file) => fs.existsSync(file));
const lines = [];
const changed = new Set();

async function text(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'aiostreams-integrated-dependency-maintenance' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

function edit(file, transform) {
  const before = fs.readFileSync(file, 'utf8');
  const after = transform(before);
  if (after !== before) {
    changed.add(path.relative(repo, file));
    if (write) fs.writeFileSync(file, after);
  }
}

async function node() {
  const major = pins.node.version.split('.')[0];
  const releases = JSON.parse(await text('https://nodejs.org/dist/index.json'));
  const latest = releases.map((r) => r.version.slice(1)).filter((v) => v.startsWith(`${major}.`) && parseSemver(v)).sort(compareSemver).at(-1);
  if (!latest || compareSemver(latest, pins.node.version) <= 0) {
    lines.push(`- Node.js ${pins.node.version}: current (newest ${major}.x).`);
    return;
  }
  const file = `node-v${latest}-win-x64.zip`;
  const sums = await text(`https://nodejs.org/dist/v${latest}/SHASUMS256.txt`);
  const sha256 = new RegExp(`^([0-9a-f]{64})\\s+${file.replace(/\./g, '\\.')}$`, 'm').exec(sums)?.[1];
  if (!sha256) throw new Error(`No SHA-256 for ${file}`);
  const previous = pins.node.version;
  lines.push(`- **Node.js ${previous} → ${latest}** (\`${file}\`, SHA-256 \`${sha256}\` from nodejs.org SHASUMS256.txt). Native modules are rebuilt for it by the Windows build; check upstream's Dockerfile uses the same major.`);
  edit(pinsPath, (s) => s.replace(JSON.stringify(pins.node.version), JSON.stringify(latest))
    .replace(pins.node.url, `https://nodejs.org/dist/v${latest}/${file}`)
    .replace(pins.node.sha256, sha256));
  for (const wf of workflows) edit(wf, (s) => s.replaceAll(`node-version: ${previous}`, `node-version: ${latest}`));
}

function actions() {
  const uses = new Map();
  for (const wf of workflows) {
    for (const match of fs.readFileSync(wf, 'utf8').matchAll(/uses: ([\w.-]+\/[\w.-]+)@([0-9a-f]{40}) # (v\d+[\w.-]*|master)/g)) uses.set(match[1], { sha: match[2], tag: match[3] });
  }
  for (const [action, { sha, tag }] of uses) {
    if (!/^v\d/.test(tag)) {
      lines.push(`- ${action} is pinned to a branch commit (${tag}); review manually.`);
      continue;
    }
    const major = tag.split('.')[0];
    const refs = execFileSync('git', ['ls-remote', '--tags', `https://github.com/${action}.git`], { encoding: 'utf8' });
    const tags = new Map();
    for (const line of refs.split('\n')) {
      const m = /^([0-9a-f]{40})\s+refs\/tags\/(v[\d.]+)(\^\{\})?$/.exec(line);
      if (m && m[2].startsWith(`${major}.`) && (m[3] || !tags.has(m[2]))) tags.set(m[2], m[1]);
    }
    const newest = [...tags.keys()].filter((t) => parseSemver(t.slice(1))).sort((a, b) => compareSemver(a.slice(1), b.slice(1))).at(-1);
    if (!newest || !parseSemver(tag.slice(1)) || compareSemver(newest.slice(1), tag.slice(1)) <= 0) continue;
    lines.push(`- **${action} ${tag} → ${newest}** (\`${tags.get(newest)}\`)`);
    for (const wf of workflows) edit(wf, (s) => s.replaceAll(`${action}@${sha} # ${tag}`, `${action}@${tags.get(newest)} # ${newest}`));
  }
}

async function vpk() {
  const versions = JSON.parse(await text('https://api.nuget.org/v3-flatcontainer/vpk/index.json')).versions.filter((v) => parseSemver(v) && !v.includes('-'));
  const newest = versions.sort(compareSemver).at(-1);
  const crate = /name = "velopack"\nversion = "([^"]+)"/.exec(fs.readFileSync(path.join(repo, 'packages/desktop/Cargo.lock'), 'utf8'))?.[1];
  lines.push(`- Velopack: vpk pin ${pins.velopack}, app crate ${crate} (from upstream), newest vpk ${newest}. Not changed automatically; follow upstream's VPK_VERSION.`);
}

await node();
actions();
await vpk().catch((e) => lines.push(`- Velopack: could not check (${e.message}).`));
console.log(`## Integration dependency maintenance\n\n${lines.join('\n')}\n\nFiles ${write ? 'changed' : 'that would change'}: ${[...changed].join(', ') || 'none'}`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed.size > 0}\nworkflows=${[...changed].some((f) => f.startsWith('.github/workflows/'))}\n`);
