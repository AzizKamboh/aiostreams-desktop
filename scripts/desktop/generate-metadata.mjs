// SPDX-License-Identifier: AGPL-3.0-only
// Build metadata also works from the shipped source archive without .git.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const manifest = path.join(repo, 'SOURCE-MANIFEST.json');
const source = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : {};
let commit = source.upstreamCommit ?? 'unknown';
let commitTime = source.upstreamCommitTime ?? null;
try {
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  if (fs.realpathSync(top) !== fs.realpathSync(repo)) throw new Error('Extracted source archive');
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
  commitTime = execFileSync('git', ['log', '-1', '--format=%cI'], { cwd: repo }).toString().trim();
} catch { /* Use recorded source provenance. */ }
fs.mkdirSync(path.join(repo, 'resources'), { recursive: true });
fs.writeFileSync(path.join(repo, 'resources/metadata.json'), JSON.stringify({
  version: pkg.version, description: pkg.description, channel: 'dev', tag: 'integrated',
  commitHash: commit.slice(0, 8), commitTime, buildTime: new Date().toISOString(),
}, null, 2) + '\n');
