// SPDX-License-Identifier: AGPL-3.0-only
// Builds the pinned AIOMetadata release and stages it beside the AIOStreams
// server, with the Redis server built by build-redis.sh:
//
//   <stage>/aiometadata/app        AIOMetadata as its Dockerfile ships it (dist,
//                                  public, production node_modules, licenses)
//   <stage>/aiometadata/desktop    preload.cjs (loopback, per-user data, stdin stop)
//   <stage>/aiometadata/redis      redis-server(.exe) and its runtime DLLs
//   <stage>/source                 AIOMetadata and Redis source (AGPL)
//   <stage>/licenses/{aiometadata,redis}
//
// Usage: node scripts/desktop/stage-aiometadata.mjs <stage-directory> [--redis <dir>] [--skip-redis]
// The source is fetched by commit and verified against runtime-pins.json; the
// build runs AIOMetadata's own npm scripts, as its Dockerfile does.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const pins = JSON.parse(fs.readFileSync(path.join(here, 'runtime-pins.json'), 'utf8'));
const pin = pins.aiometadata;

let stageArg;
let redisArg = path.join(repo, '.embedded-build/redis/dist');
let skipRedis = false;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--redis') redisArg = process.argv[++i];
  else if (arg === '--skip-redis') skipRedis = true;
  else if (!arg.startsWith('--') && !stageArg) stageArg = arg;
  else throw new Error(`Unknown argument ${arg}`);
}
if (!stageArg || !redisArg) {
  throw new Error('Usage: node scripts/desktop/stage-aiometadata.mjs <stage-directory> [--redis <dir>] [--skip-redis]');
}
const stage = path.resolve(stageArg);
const redisDir = path.resolve(redisArg);

const work = path.join(repo, '.embedded-build');
const source = path.join(work, 'aiometadata-src');
const target = path.join(stage, 'aiometadata');
const app = path.join(target, 'app');

function run(command, commandArgs, cwd) {
  console.log(`> ${command} ${commandArgs.join(' ')}`);
  // npm is a .cmd shim on Windows; the arguments here are fixed strings.
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32' && command === 'npm',
    env: { ...process.env, DOTENV_CONFIG_QUIET: 'true' },
  });
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} failed (${result.status ?? result.error})`);
}
function output(command, commandArgs, cwd) {
  const result = spawnSync(command, commandArgs, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}
const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, dereference: true });
};

if (!/^[0-9a-f]{40}$/.test(pin.commit)) throw new Error('runtime-pins.json: aiometadata.commit must be a full commit id');
if (fs.existsSync(target)) throw new Error(`Stage directory must not contain aiometadata yet: ${target}`);

// 1. Source at the pinned commit.
if (!fs.existsSync(path.join(source, '.git'))) {
  fs.mkdirSync(source, { recursive: true });
  run('git', ['init', '--quiet'], source);
}
if (spawnSync('git', ['cat-file', '-e', `${pin.commit}^{commit}`], { cwd: source }).status !== 0) {
  run('git', ['fetch', '--depth', '1', '--no-tags', pin.repository, pin.commit], source);
}
run('git', ['checkout', '--quiet', '--force', '--detach', pin.commit], source);
run('git', ['clean', '-xdfq', '-e', 'node_modules/'], source);
const head = output('git', ['rev-parse', 'HEAD'], source);
if (head !== pin.commit) throw new Error(`AIOMetadata checkout is ${head}, expected ${pin.commit}`);
const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
if (pkg.version !== pin.version) throw new Error(`AIOMetadata ${pkg.version} does not match the pinned ${pin.version}`);

// 2. Build (frontend and backend), exactly as AIOMetadata's Dockerfile does.
run('npm', ['ci', '--no-audit', '--no-fund'], source);
run('npm', ['run', 'build'], source);
run('npm', ['run', 'build:backend'], source);
for (const required of ['dist/server/server.js', 'dist/server/lib/runtimePaths.js', 'dist/client/index.html']) {
  if (!fs.existsSync(path.join(source, required))) throw new Error(`AIOMetadata build produced no ${required}`);
}

// 3. Runtime: production dependencies only, no build tools.
fs.mkdirSync(app, { recursive: true });
for (const file of ['package.json', 'package-lock.json']) copy(path.join(source, file), path.join(app, file));
for (const dir of ['dist', 'public']) copy(path.join(source, dir), path.join(app, dir));
fs.rmSync(path.join(app, 'dist/tsconfig.backend.tsbuildinfo'), { force: true });
run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], app);
// AIOMetadata lists its configuration page's libraries (React, icon sets,
// charts: most of the install) as dependencies, but Vite has already bundled
// them into dist/client. Keep only the packages the compiled server loads.
const serverCode = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (file.endsWith('.js')) serverCode.push(fs.readFileSync(file, 'utf8'));
  }
})(path.join(app, 'dist/server'));
const code = serverCode.join('\n');
const appPackagePath = path.join(app, 'package.json');
const appPackage = JSON.parse(fs.readFileSync(appPackagePath, 'utf8'));
const loaded = (name) => new RegExp(
  `(?:require\\(|from |import\\()\\s*["']${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?:/[^"']*)?["']`,
).test(code);
const kept = Object.fromEntries(Object.entries(appPackage.dependencies).filter(([name]) => loaded(name)));
const dropped = Object.keys(appPackage.dependencies).filter((name) => !(name in kept));
for (const required of ['express', 'ioredis', 'better-sqlite3']) {
  if (!(required in kept)) throw new Error(`Server dependency detection lost ${required}; check the compiled server layout`);
}
appPackage.dependencies = kept;
delete appPackage.devDependencies;
delete appPackage.scripts;
fs.writeFileSync(appPackagePath, JSON.stringify(appPackage, null, 2) + '\n');
console.log(`Configuration-page-only packages removed from the runtime: ${dropped.join(', ') || 'none'}`);
run('npm', ['prune', '--omit=dev', '--no-audit', '--no-fund'], app);
fs.rmSync(path.join(app, 'node_modules/.bin'), { recursive: true, force: true });
fs.rmSync(path.join(app, 'node_modules/.package-lock.json'), { force: true });

// 4. Licenses and notices, in the app (as the Docker image has them) and in licenses/.
const legal = ['LICENSE', 'LICENSE-FSL.md', 'LICENSING.md', 'NOTICE', 'TRADEMARKS.md', 'THIRD_PARTY_NOTICES.txt'];
for (const file of legal) {
  const from = path.join(source, file);
  if (!fs.existsSync(from)) {
    if (file === 'THIRD_PARTY_NOTICES.txt') continue; // generated by its notices script in some releases
    throw new Error(`AIOMetadata ${file} is missing`);
  }
  copy(from, path.join(app, file));
  copy(from, path.join(stage, 'licenses/aiometadata', file));
}
if (fs.existsSync(path.join(source, 'LICENSES'))) {
  copy(path.join(source, 'LICENSES'), path.join(app, 'LICENSES'));
  copy(path.join(source, 'LICENSES'), path.join(stage, 'licenses/aiometadata/LICENSES'));
}

// 5. Corresponding source (AGPL-3.0 core, FSL modules), from the verified commit.
fs.mkdirSync(path.join(stage, 'source'), { recursive: true });
run('git', [
  'archive', '--format=tar.gz', `--prefix=aiometadata-${pin.version}/`,
  '-o', path.join(stage, 'source', `aiometadata-${pin.version}-source.tar.gz`), pin.commit,
], source);

// 6. The integration's preload.
copy(path.join(here, 'aiometadata/preload.cjs'), path.join(target, 'desktop/preload.cjs'));

// 7. Redis.
if (!skipRedis) {
  const server = process.platform === 'win32' ? 'redis-server.exe' : 'redis-server';
  if (!fs.existsSync(path.join(redisDir, server))) {
    throw new Error(`No ${server} in ${redisDir}; run scripts/desktop/build-redis.sh in MSYS2 (MSYSTEM=MSYS) first.`);
  }
  for (const entry of fs.readdirSync(redisDir)) {
    if (entry === 'licenses') continue;
    copy(path.join(redisDir, entry), path.join(target, 'redis', entry));
  }
  copy(path.join(redisDir, 'licenses'), path.join(stage, 'licenses/redis'));
  const archive = path.join(work, `redis-${pins.redis.version}.tar.gz`);
  if (fs.existsSync(archive)) copy(archive, path.join(stage, 'source', `redis-${pins.redis.version}.tar.gz`));
  else throw new Error(`Redis source ${archive} is missing; build-redis.sh keeps it there.`);
}

fs.writeFileSync(path.join(target, 'VERSION.json'), JSON.stringify({
  aiometadata: { version: pin.version, commit: pin.commit, repository: pin.repository },
  redis: skipRedis ? null : { version: pins.redis.version },
}, null, 2) + '\n');
console.log(`Staged AIOMetadata ${pin.version}${skipRedis ? '' : ` with Redis ${pins.redis.version}`} in ${target}`);
