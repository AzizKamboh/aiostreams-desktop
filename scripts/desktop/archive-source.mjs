// SPDX-License-Identifier: AGPL-3.0-only
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const destination = path.resolve(process.argv[2] ?? '.embedded-releases/aiostreams-integrated-source.tar.gz');
fs.mkdirSync(path.dirname(destination), { recursive: true });
const manifestPath = path.join(repo, 'SOURCE-MANIFEST.json');
const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
// The upstream revision this source integrates; .github/upstream-sync.json is authoritative.
const trackingPath = path.join(repo, '.github/upstream-sync.json');
const baseline = fs.existsSync(trackingPath) ? JSON.parse(fs.readFileSync(trackingPath, 'utf8')).baseline ?? {} : {};
const upstreamCommit = baseline.commit ?? previous.upstreamCommit ?? '76a5d6da6d1babf885c7f65a2e19bbd55401a26d';
const upstreamCommitTime = baseline.commitTime ?? previous.upstreamCommitTime ?? null;
let names;
let commit = previous.sourceCommit ?? previous.upstreamCommit ?? 'unknown';
let commitTime = previous.sourceCommitTime ?? previous.upstreamCommitTime ?? null;
try {
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  if (fs.realpathSync(top) !== fs.realpathSync(repo)) throw new Error('This is an extracted source archive');
  names = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repo }).toString('utf8').split('\0').filter(Boolean);
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
  commitTime = execFileSync('git', ['log', '-1', '--format=%cI'], { cwd: repo }).toString().trim();
} catch {
  // Source archives intentionally contain no .git. Keep the original source
  // manifest and discover new source files while excluding build/user data.
  const known = new Set(previous.files ?? []);
  const excluded = new Set(['.git', 'node_modules', 'target', 'vendor', 'dist', 'dist-standalone', 'build', 'out', '.next', '.wrangler', '.cache', '.embedded-build', '.embedded-releases', 'work', 'data', 'logs', '.codex', '.agents', '.aws', 'attachments']);
  names = [];
  function visit(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name) || [...known].some((file) => file.startsWith(name + '/'))) visit(path.join(dir, entry.name), name);
      } else if (entry.isFile() && (known.has(name) || (!/^\.env(?:\.|$)/.test(entry.name) && !/\.(?:tsbuildinfo|log|sqlite|sqlite3|db)$/.test(entry.name)))) {
        names.push(name);
      }
    }
  }
  visit(repo);
}
const files = [...new Set([...names, 'SOURCE-MANIFEST.json'])].filter((name) => path.resolve(repo, name) !== destination && (name === 'SOURCE-MANIFEST.json' || fs.existsSync(path.join(repo, name)))).sort();
fs.writeFileSync(manifestPath, JSON.stringify({ upstreamCommit, upstreamCommitTime, upstreamRef: baseline.ref ?? null, upstreamServerVersion: baseline.serverVersion ?? null, upstreamDesktopVersion: baseline.desktopVersion ?? null, sourceCommit: commit, sourceCommitTime: commitTime, files }, null, 2) + '\n');
if (files.some((name) => name.includes('\n') || name.startsWith('-'))) throw new Error('Unsupported source filename');
const list = path.join(repo, '.embedded-build/source-files.txt');
fs.mkdirSync(path.dirname(list), { recursive: true });
fs.writeFileSync(list, files.join('\n') + '\n');
execFileSync('tar', ['-czf', destination, '-T', list], { cwd: repo, stdio: 'inherit' });
console.log(`Archived ${files.length} source files to ${destination}`);
