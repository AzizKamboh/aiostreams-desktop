// SPDX-License-Identifier: AGPL-3.0-only
// A portable Node installation must not contain pnpm's machine-specific junctions.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [mode, stageArg] = process.argv.slice(2);
if (!['prepare', 'finalize'].includes(mode) || !stageArg) {
  throw new Error('Usage: node scripts/desktop/stage-runtime.mjs prepare|finalize <stage-directory>');
}
const stage = path.resolve(stageArg);
const runtime = path.join(stage, 'backend/app');
const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, dereference: true });
};
const packages = ['server', 'core', 'crypto'];

if (mode === 'prepare') {
  if (fs.existsSync(runtime)) throw new Error(`Runtime directory must be fresh: ${runtime}`);
  fs.mkdirSync(runtime, { recursive: true });
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'LICENSE']) {
    copy(path.join(repo, file), path.join(runtime, file));
  }
  for (const dir of ['patches', 'resources']) copy(path.join(repo, dir), path.join(runtime, dir));
  for (const pkg of packages) {
    copy(path.join(repo, 'packages', pkg, 'package.json'), path.join(runtime, 'packages', pkg, 'package.json'));
  }
  // The optional crypto addon was built on the build machine; end-user payloads
  // contain its binary or use upstream's node:crypto fallback, never node-gyp.
  const cryptoJson = path.join(runtime, 'packages/crypto/package.json');
  const cryptoPackage = JSON.parse(fs.readFileSync(cryptoJson, 'utf8'));
  delete cryptoPackage.scripts;
  fs.writeFileSync(cryptoJson, JSON.stringify(cryptoPackage, null, 2) + '\n');
  for (const pkg of ['server', 'core', 'frontend', 'web']) {
    copy(path.join(repo, 'packages', pkg, 'dist'), path.join(runtime, 'packages', pkg, 'dist'));
  }
  copy(path.join(repo, 'packages/server/src/static'), path.join(runtime, 'packages/server/dist/static'));
  for (const file of ['index.js', 'index.d.ts']) {
    copy(path.join(repo, 'packages/crypto', file), path.join(runtime, 'packages/crypto', file));
  }
  const native = path.join(repo, 'packages/crypto/build/Release/aios_crypto.node');
  if (fs.existsSync(native)) copy(native, path.join(runtime, 'packages/crypto/build/Release/aios_crypto.node'));
  copy(path.join(repo, 'packages/web/dist-standalone'), path.join(stage, 'web'));
  console.log('Runtime sources staged. Install production dependencies with node-linker=hoisted, then finalize.');
} else {
  const packageRoots = new Map(packages.map((pkg) => {
    const dir = path.join(runtime, 'packages', pkg);
    return [fs.realpathSync(dir).toLowerCase(), dir];
  }));
  // pnpm uses junctions for workspace packages even with a hoisted linker. Replace
  // those with tiny package entry points pointing to the real monorepo location.
  // Core computes its templates directory relative to that location.
  function materialize(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.name === '.bin') { fs.rmSync(file, { recursive: true, force: true }); continue; }
      if (entry.isSymbolicLink()) {
        const real = fs.realpathSync(file);
        const workspace = packageRoots.get(real.toLowerCase());
        if (workspace) {
          const original = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'));
          const main = path.relative(file, path.join(workspace, original.main)).split(path.sep).join('/');
          fs.rmSync(file, { recursive: true, force: true });
          fs.mkdirSync(file, { recursive: true });
          fs.writeFileSync(path.join(file, 'package.json'), JSON.stringify({
            name: original.name, version: original.version, type: original.type, main,
          }, null, 2) + '\n');
        } else {
          if (!real.startsWith(runtime + path.sep)) throw new Error(`Dependency points outside staged runtime: ${file}`);
          fs.rmSync(file, { recursive: true, force: true });
          copy(real, file);
          if (fs.statSync(file).isDirectory()) materialize(file);
        }
      } else if (entry.isDirectory()) materialize(file);
    }
  }
  materialize(runtime);
  const notices = path.join(stage, 'licenses/npm');
  fs.mkdirSync(notices, { recursive: true });
  const seen = new Set();
  const manifest = [];
  function collect(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sub = path.join(dir, entry.name);
      const json = path.join(sub, 'package.json');
      if (fs.existsSync(json)) {
        const pkg = JSON.parse(fs.readFileSync(json, 'utf8'));
        const key = `${pkg.name}@${pkg.version}`;
        if (typeof pkg.name === 'string' && typeof pkg.version === 'string' && !seen.has(key)) {
          seen.add(key);
          const dst = path.join(notices, key.replace(/[^a-zA-Z0-9._-]/g, '_'));
          fs.mkdirSync(dst, { recursive: true });
          copy(json, path.join(dst, 'package.json'));
          const files = fs.readdirSync(sub).filter((name) => /^(licen[sc]e|copying|notice|copyright)([.\-_]|$)/i.test(name));
          for (const name of files) copy(path.join(sub, name), path.join(dst, name));
          manifest.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? null, repository: pkg.repository ?? null, notices: files });
        }
      }
      collect(sub);
    }
  }
  collect(path.join(runtime, 'node_modules'));
  fs.writeFileSync(path.join(stage, 'third-party-node-packages.json'), JSON.stringify(manifest.sort((a, b) => a.name.localeCompare(b.name)), null, 2) + '\n');
  console.log(`Staged portable runtime with ${manifest.length} dependency notice entries.`);
}
