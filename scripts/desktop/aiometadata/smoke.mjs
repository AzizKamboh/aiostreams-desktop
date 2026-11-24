// SPDX-License-Identifier: AGPL-3.0-only
// Starts the staged Redis and AIOMetadata the way the desktop app does
// (packages/desktop/app/src/backend/aiometadata.rs) and checks that:
// - Redis has the Redis 8 commands AIOMetadata needs and keeps data across a
//   restart (append-only file),
// - AIOMetadata becomes ready, serves its manifest and configuration page,
//   listens on loopback only and stops cleanly when asked on stdin.
//
// Usage: node scripts/desktop/aiometadata/smoke.mjs --stage <dir> [--node <node>]
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const option = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const stage = path.resolve(option('--stage', ''));
const node = option('--node', process.execPath);
const target = path.join(stage, 'aiometadata');
const redisServer = path.join(target, 'redis', process.platform === 'win32' ? 'redis-server.exe' : 'redis-server');
const appRoot = path.join(target, 'app');
const preload = path.join(target, 'desktop', 'preload.cjs');
for (const file of [redisServer, path.join(appRoot, 'dist/server/server.js'), preload]) {
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}`);
}

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'AIOMetadata smoke ü '));
const state = path.join(data, 'state');
const redisData = path.join(data, 'redis');
fs.mkdirSync(state, { recursive: true });
fs.mkdirSync(redisData, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = new Set();
let failed = false;
const fail = (message) => {
  failed = true;
  throw new Error(message);
};

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** One RESP command; returns the raw reply text. */
function redis(port, password, ...command) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const encode = (parts) => `*${parts.length}\r\n${parts.map((p) => `$${Buffer.byteLength(String(p))}\r\n${p}\r\n`).join('')}`;
    let reply = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('Redis timed out')));
    socket.on('error', reject);
    socket.on('data', (chunk) => (reply += chunk));
    // QUIT makes the server close the connection after the replies.
    socket.on('connect', () => socket.write(encode(['AUTH', password]) + encode(command) + encode(['QUIT'])));
    socket.on('close', () => {
      if (!reply.startsWith('+OK\r\n')) return reject(new Error(`AUTH failed: ${reply.split('\r\n')[0]}`));
      resolve(reply.slice(5));
    });
  });
}

function redisConf(port, password) {
  // Mirrors redis_config() in aiometadata.rs: paths stay relative to the
  // working directory, so no Windows path passes through Redis's POSIX runtime.
  fs.writeFileSync(path.join(redisData, 'redis.conf'), [
    'bind 127.0.0.1', 'protected-mode yes', `port ${port}`, `requirepass ${password}`,
    'dir .', 'save ""', 'appendonly yes', 'appendfsync everysec',
    'maxmemory 1gb', 'daemonize no', 'loglevel warning', 'logfile ""', '',
  ].join('\n'));
  return 'redis.conf';
}

async function startRedis() {
  const port = await freePort();
  const password = crypto.randomBytes(32).toString('hex');
  const child = spawn(redisServer, [redisConf(port, password)], { cwd: redisData, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.add(child);
  let log = '';
  child.stdout.on('data', (c) => (log += c));
  child.stderr.on('data', (c) => (log += c));
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) fail(`Redis exited with ${child.exitCode}:\n${log}`);
    try {
      if ((await redis(port, password, 'PING')).startsWith('+PONG')) return { child, port, password };
    } catch { /* not listening yet */ }
    await sleep(200);
  }
  fail(`Redis did not answer:\n${log}`);
}

async function stopRedis({ child, port, password }) {
  await redis(port, password, 'SHUTDOWN').catch(() => undefined);
  for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(200);
  if (child.exitCode === null) fail('Redis did not shut down');
  children.delete(child);
}

async function get(port, pathname) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { redirect: 'manual' });
  return { status: response.status, text: await response.text() };
}

try {
  // Redis: version, Redis 8 commands, persistence.
  let r = await startRedis();
  const info = await redis(r.port, r.password, 'INFO', 'server');
  const version = /redis_version:(\S+)/.exec(info)?.[1];
  console.log(`Redis ${version}`);
  for (const command of ['hsetex', 'httl']) {
    const reply = await redis(r.port, r.password, 'COMMAND', 'INFO', command);
    if (reply.startsWith('*1\r\n*-1') || reply.startsWith('*1\r\n$-1')) fail(`Redis lacks ${command.toUpperCase()}`);
  }
  await redis(r.port, r.password, 'HSETEX', 'smoke:hash', 'EX', '3600', 'FIELDS', '1', 'f', 'v');
  await redis(r.port, r.password, 'SET', 'smoke:kept', 'yes');
  await stopRedis(r);
  r = await startRedis();
  if (!(await redis(r.port, r.password, 'GET', 'smoke:kept')).includes('yes')) fail('Redis lost data across a restart');
  console.log('Redis: HSETEX/HTTL present, data kept across restart');

  // AIOMetadata.
  const port = await freePort();
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    HOST_NAME: `http://127.0.0.1:${port}`,
    DATABASE_URI: 'sqlite://./addon/data/db.sqlite',
    REDIS_URL: `redis://:${r.password}@127.0.0.1:${r.port}`,
    IMAGE_PROXY_SIGNING_SECRET: crypto.randomBytes(32).toString('hex'),
    AIOMETADATA_DESKTOP_APP_ROOT: appRoot,
    AIOMETADATA_DESKTOP_STDIN_CONTROL: '1',
    DOTENV_CONFIG_QUIET: 'true',
    ENABLE_CACHE_WARMING: 'false',
    CACHE_WARMUP_ON_STARTUP: 'false',
    MAL_WARMUP_ENABLED: 'false',
    TMDB_POPULAR_WARMING_ENABLED: 'false',
  };
  delete env.NODE_OPTIONS;
  const server = spawn(node, ['-r', preload, path.join(appRoot, 'dist/server/server.js')], {
    cwd: state, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  children.add(server);
  let log = '';
  server.stdout.on('data', (c) => (log += c));
  server.stderr.on('data', (c) => (log += c));
  let ready = false;
  for (let i = 0; i < 600 && !ready; i++) {
    if (server.exitCode !== null) fail(`AIOMetadata exited with ${server.exitCode}:\n${log}`);
    ready = await get(port, '/health/ready').then((x) => x.status === 200, () => false);
    if (!ready) await sleep(500);
  }
  if (!ready) fail(`AIOMetadata did not become ready:\n${log}`);
  const manifest = JSON.parse((await get(port, '/manifest.json')).text);
  if (manifest.id !== 'com.aio.metadata') fail(`Unexpected manifest ${manifest.id}`);
  const configure = await get(port, '/configure/');
  if (configure.status !== 200 || !/<html/i.test(configure.text)) fail(`Configuration page answered ${configure.status}`);
  if (!fs.existsSync(path.join(state, 'addon/data/db.sqlite'))) fail('AIOMetadata did not keep its database in the per-user folder');
  // Loopback only: no other local address may reach it.
  const external = Object.values(os.networkInterfaces()).flat().find((a) => a && !a.internal && a.family === 'IPv4');
  if (external) {
    const reachable = await new Promise((resolve) => {
      const s = net.connect(port, external.address);
      s.setTimeout(1500, () => { s.destroy(); resolve(false); });
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
    });
    if (reachable) fail(`AIOMetadata is reachable on ${external.address}`);
  }
  console.log(`AIOMetadata ${manifest.version}: ready, manifest and configuration page served, loopback only`);

  server.stdin.write('{"command":"shutdown"}\n');
  for (let i = 0; i < 100 && server.exitCode === null; i++) await sleep(200);
  if (server.exitCode !== 0) fail(`AIOMetadata did not stop cleanly (exit ${server.exitCode}):\n${log.slice(-4000)}`);
  children.delete(server);
  await stopRedis(r);
  console.log('AIOMetadata smoke test passed');
} finally {
  for (const child of children) child.kill();
  await sleep(500);
  if (!failed) fs.rmSync(data, { recursive: true, force: true });
}
