#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Real, offline-fixture integration checks for the embedded backend. No Docker.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} needs a value`);
  return args[index + 1];
}
const appRoot = path.resolve(option('--app-root', path.join(here, '../..')));
const node = path.resolve(option('--node', process.execPath));
const ffprobe = option('--ffprobe', null);
const ffmpeg = option('--ffmpeg', null);
const dataRoot = await mkdtemp(path.join(tmpdir(), 'AIOStreams smoke 空間 '));
const secret = randomBytes(32).toString('hex');
const password = randomBytes(24).toString('hex');
const admin = 'desktop-smoke';
const media = await readFile(path.join(here, 'fixtures/test-pattern.mp4'));
let current;
let fixture;
let occupied;
let fixtureBase;
let mediaRequests = 0;
const leaks = [];
const completed = [];

function pass(name) { completed.push(name); console.log(`PASS ${name}`); }
function redact(text) {
  return String(text)
    .replaceAll(secret, '[secret]').replaceAll(password, '[password]')
    .replace(/[a-f0-9]{64}/gi, '[token]')
    .replace(/(__desktop_token=)[^&\s"']+/g, '$1[redacted]');
}
async function listen(server, port = 0) {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function availablePort() {
  const listener = createServer();
  const port = await listen(listener);
  await new Promise((resolve) => listener.close(resolve));
  return port;
}
async function seedData(dir) {
  // Keep startup deterministic without downloading upstream optional datasets.
  await mkdir(path.join(dir, 'data/seadex'), { recursive: true });
  await writeFile(path.join(dir, 'data/seadex/trs.json'), JSON.stringify({ torrentsByAnilistId: {}, lastUpdated: Date.now() }));
}
function launch(port, dir = dataRoot) {
  const token = randomBytes(32).toString('hex');
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(node, [path.join(appRoot, 'packages/server/dist/server.js')], {
    cwd: dir,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'production', PORT: String(port), BASE_URL: base, INTERNAL_URL: base,
      DATABASE_URI: 'sqlite://./data/db.sqlite', SECRET_KEY: secret,
      AIOSTREAMS_DESKTOP_TOKEN: token, AIOSTREAMS_DESKTOP_STDIN_CONTROL: '1',
      AIOSTREAMS_AUTH: `${admin}:${password}`, AIOSTREAMS_AUTH_REQUIRED: 'false',
      AIOSTREAMS_AUTH_PERMISSIONS: `${admin}=admin`,
      ANALYTICS_ENABLED: 'false', USER_ANALYTICS_ENABLED: 'false',
      ANIME_DB_LEVEL_OF_DETAIL: 'none', ID_MAPPINGS_ENABLED: 'false',
      SCENE_MAPPINGS_ENABLED: 'false', TITLE_CONFLICTS_ENABLED: 'false',
      TEMPLATE_URLS: '[]', COMMUNITY_REMOTE_SOURCES: '[]',
      WATCH_STATE_REPORT_ENABLED: 'false', WATCH_STATE_PULL_ENABLED: 'false',
      ALLOW_PRIVATE_URLS: 'true', LOG_LEVEL: 'warn',
      ...(ffprobe ? { FFPROBE_PATH: path.resolve(ffprobe) } : {}),
    },
  });
  const state = { child, token, base, port, output: '', ready: false, exited: false, code: null, error: null, cookie: '' };
  child.on('error', (error) => { state.error = error; });
  child.on('exit', (code) => { state.exited = true; state.code = code; });
  child.stdin.on('error', () => {});
  const collect = (chunk) => {
    state.output = (state.output + chunk.toString()).slice(-16000);
    state.ready ||= state.output.includes('"event":"aiostreams-desktop-ready"') || state.output.includes('"event": "aiostreams-desktop-ready"');
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  return state;
}
async function waitExit(state, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!state.exited && !state.error && Date.now() < deadline) await delay(50);
  if (state.error) throw state.error;
  assert.ok(state.exited, `Backend PID ${state.child.pid} did not exit within ${timeout} ms`);
  for (const credential of [secret, password, state.token]) {
    assert.ok(!state.output.includes(credential), 'A generated credential appeared in backend logs');
  }
}
async function ready(state) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (state.error) throw state.error;
    if (state.exited) throw new Error(`Backend exited (${state.code}) before ready:\n${redact(state.output)}`);
    if (state.ready) {
      const response = await api(state, '/api/v1/health');
      if (response.ok) {
        assert.equal((await response.json()).success, true);
        return;
      }
    }
    await delay(100);
  }
  throw new Error(`Backend did not become ready:\n${redact(state.output)}`);
}
async function api(state, pathname, options = {}) {
  return fetch(`${state.base}${pathname}`, {
    ...options,
    signal: AbortSignal.timeout(15000),
    headers: {
      'X-AIOStreams-Desktop-Token': state.token,
      ...(state.cookie ? { Cookie: state.cookie } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
}
async function rawStatus(state, headers) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${state.base}/api/v1/health`, {
      headers: { 'X-AIOStreams-Desktop-Token': state.token, ...headers },
      timeout: 5000,
    }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('HTTP header test timed out')));
    request.end();
  });
}
async function json(state, pathname, options = {}) {
  const response = await api(state, pathname, options);
  const body = await response.json();
  assert.ok(response.ok, `${pathname}: ${response.status} ${redact(JSON.stringify(body))}`);
  assert.notEqual(body.success, false, `${pathname}: ${redact(JSON.stringify(body))}`);
  return body;
}
async function login(state) {
  const response = await api(state, '/api/v1/auth/login', {
    method: 'POST', body: JSON.stringify({ username: admin, password }),
  });
  assert.equal(response.status, 200, `Admin sign-in failed: ${redact(await response.text())}`);
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith('aiostreams.session='));
  assert.ok(cookie, 'Missing admin session cookie');
  state.cookie = cookie.split(';')[0];
}
async function shutdown(state, command = true) {
  if (command) state.child.stdin.write('{"command":"shutdown"}\n');
  else state.child.stdin.end();
  await waitExit(state);
  assert.equal(state.code, 0, `Unclean backend exit:\n${redact(state.output)}`);
  await assert.rejects(fetch(`${state.base}/api/v1/health`, { signal: AbortSignal.timeout(1000) }));
}
async function verifySaved(state, uuid) {
  await login(state);
  const exported = await json(state, '/api/v1/dashboard/settings/export');
  assert.equal(exported.data.settings['branding.addonName'], 'Desktop smoke 空間');
  assert.equal(exported.data.settings['usenet.performanceProfile'], 'conservative');
  const config = await json(state, '/api/v1/user?raw=true', {
    headers: { Authorization: `Basic ${Buffer.from(`${uuid}:${password}`).toString('base64')}` },
  });
  assert.equal(config.data.userData.presets[0].options.manifestUrl, `${fixtureBase}/manifest.json`);
  assert.equal(config.data.userData.addonName, 'Local fixture profile');
}

try {
  await stat(path.join(appRoot, 'packages/server/dist/server.js'));
  await seedData(dataRoot);
  fixture = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (req.headers['x-aiostreams-desktop-token'] || req.headers['x-aiostreams-internal-secret'] || url.searchParams.has('__desktop_token') || /aiostreams\.(?:desktop|session)/i.test(req.headers.cookie ?? '')) leaks.push(req.url);
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (url.pathname === '/manifest.json') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'org.aiostreams.desktop-smoke', version: '1.0.0', name: 'Local test fixture', description: 'Generated CC0 test media', resources: ['stream'], types: ['movie'], catalogs: [], idPrefixes: ['desktop-smoke:'] }));
    } else if (url.pathname.startsWith('/stream/movie/')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ streams: [{ name: 'Local fixture', title: 'Generated blue frame', url: `${fixtureBase}/test-pattern.mp4`, behaviorHints: { filename: 'Generated.Test.Pattern.720p.mp4' } }] }));
    } else if (url.pathname === '/test-pattern.mp4') {
      mediaRequests++;
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
      const start = match ? Number(match[1]) : 0;
      const end = match && match[2] ? Math.min(Number(match[2]), media.length - 1) : media.length - 1;
      if (start >= media.length || end < start) { res.writeHead(416); res.end(); return; }
      if (match) { res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${media.length}`); }
      res.setHeader('Content-Length', end - start + 1);
      res.end(req.method === 'HEAD' ? undefined : media.subarray(start, end + 1));
    } else { res.writeHead(404); res.end(); }
  });
  fixtureBase = `http://127.0.0.1:${await listen(fixture)}`;
  current = launch(await availablePort());
  await ready(current);
  pass('fresh database and health check in a path containing spaces and Unicode');
  const unauthorised = await fetch(`${current.base}/api/v1/health`);
  assert.ok([401, 403].includes(unauthorised.status), 'Embedded backend accepted request without capability');
  const crossOrigin = await api(current, '/api/v1/health', { headers: { Origin: 'https://untrusted.example' } });
  assert.equal(crossOrigin.status, 403, 'Embedded backend accepted a foreign browser origin');
  // Fetch normalises Host; use an HTTP request to exercise the literal header.
  const wrongHost = await rawStatus(current, { Host: `attacker.example:${current.port}` });
  assert.equal(wrongHost, 403, 'Embedded backend accepted a DNS-rebinding Host');
  const bootstrap = await fetch(`${current.base}/__desktop/session?__desktop_token=${current.token}`, { redirect: 'manual' });
  assert.ok([302, 303, 307].includes(bootstrap.status));
  assert.ok(bootstrap.headers.get('set-cookie')?.includes('HttpOnly'));
  const redirect = await fetch(`${current.base}/configure?__desktop_token=${current.token}`, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  const redirectUrl = new URL(redirect.headers.get('location'), current.base);
  assert.equal(redirectUrl.origin, current.base);
  assert.equal(redirectUrl.searchParams.get('__desktop_token'), current.token);
  assert.equal((await fetch(redirectUrl)).status, 200, 'Native local redirect lost desktop capability');
  const dashboard = await api(current, '/stremio/configure');
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.headers.get('content-type'), /text\/html/);
  pass('private backend authentication and real configuration interface');
  // The account the setup screen saves reaches upstream as AIOSTREAMS_AUTH and
  // passes the exact check the built-in Usenet service runs before streaming.
  const loaded = await json(current, '/__desktop/accounts');
  assert.deepEqual(loaded.accounts.map((a) => a.username), [admin], 'Internal account leaked or user account missing');
  assert.ok(loaded.accounts[0].permissions.includes('service'));
  assert.equal((await json(current, '/__desktop/account-check', {
    method: 'POST', body: JSON.stringify({ credential: `${admin}:${password}` }),
  })).success, true);
  for (const credential of [`${admin}:wrong-password`, `nobody:${password}`, `desktop:${password}`, 'garbage']) {
    const rejected = await (await api(current, '/__desktop/account-check', {
      method: 'POST', body: JSON.stringify({ credential }),
    })).json();
    assert.equal(rejected.success, false, 'A wrong credential passed the Usenet service check');
  }
  const sessionCookie = bootstrap.headers.getSetCookie().find((value) => value.startsWith('aiostreams.session='));
  assert.ok(sessionCookie, 'Internal desktop dashboard session missing beside a user account');
  const internalSession = await api(current, '/api/v1/dashboard/settings/export', { headers: { Cookie: sessionCookie.split(';')[0] } });
  assert.equal(internalSession.status, 200, 'Internal desktop admin session was not accepted');
  pass('user AIOSTREAMS_AUTH account passes the built-in Usenet service check; internal dashboard account kept');
  await login(current);
  const imported = await json(current, '/api/v1/dashboard/settings/import/json', {
    method: 'POST', body: JSON.stringify({ settings: { 'branding.addonName': 'Desktop smoke 空間', 'usenet.performanceProfile': 'conservative' } }),
  });
  assert.deepEqual(imported.data.failed, []);
  assert.equal(imported.data.imported.length, 2);
  const created = await json(current, '/api/v1/user', {
    method: 'POST', body: JSON.stringify({ password, config: {
      addonName: 'Local fixture profile', formatter: { id: 'gdrive' }, sortCriteria: { global: [] },
      presets: [{ type: 'custom', instanceId: 'local-fixture', enabled: true, options: { name: 'Local fixture', manifestUrl: `${fixtureBase}/manifest.json`, timeout: 10000, formatPassthrough: true } }],
    } }),
  });
  const { uuid, encryptedPassword } = created.data;
  await verifySaved(current, uuid);
  pass('supported settings import/export, custom addon configuration and profile persistence');
  const streams = await json(current, `/stremio/${uuid}/${encryptedPassword}/stream/movie/desktop-smoke:sample.json`);
  assert.ok(streams.streams.some((stream) => stream.url === `${fixtureBase}/test-pattern.mp4`), 'Custom addon stream did not survive aggregation');
  const generated = await json(current, '/api/v1/proxy/generate', {
    method: 'POST', body: JSON.stringify({ url: `${fixtureBase}/test-pattern.mp4`, filename: 'test-pattern.mp4', type: 'stream' }),
  });
  const play = new URL(generated.proxified_url);
  assert.equal(play.origin, current.base, 'Generated playback URL has wrong dynamic server port');
  play.searchParams.set('__desktop_token', current.token);
  const streamed = await fetch(play, { signal: AbortSignal.timeout(15000) });
  assert.equal(streamed.status, 200);
  assert.deepEqual(Buffer.from(await streamed.arrayBuffer()), media);
  const range = await fetch(play, { headers: { Range: 'bytes=100-299' }, signal: AbortSignal.timeout(15000) });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 100-299/${media.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), media.subarray(100, 300));
  const nested = await json(current, '/api/v1/proxy/generate', {
    method: 'POST', body: JSON.stringify({ url: generated.proxified_url, filename: 'nested-test-pattern.mp4', type: 'stream' }),
  });
  const nestedPlay = new URL(nested.proxified_url);
  nestedPlay.searchParams.set('__desktop_token', current.token);
  const nestedResponse = await fetch(nestedPlay, { signal: AbortSignal.timeout(15000) });
  assert.equal(nestedResponse.status, 200, 'Internal local proxy hop lost server authentication');
  assert.deepEqual(Buffer.from(await nestedResponse.arrayBuffer()), media);
  assert.ok(mediaRequests >= 2);
  assert.deepEqual(leaks, [], 'Desktop capability leaked to upstream media fixture');
  pass('real addon aggregation, generated local proxy URL, complete media transfer and byte-range seeking');
  if (ffprobe) {
    const probe = spawn(path.resolve(ffprobe), ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', play.href], { windowsHide: true });
    let output = '';
    let errors = '';
    probe.stdout.on('data', (chunk) => { output += chunk; });
    probe.stderr.on('data', (chunk) => { errors += chunk; });
    const timeout = setTimeout(() => probe.kill(), 15000);
    const [code] = await once(probe, 'exit');
    clearTimeout(timeout);
    assert.equal(code, 0, redact(errors));
    const probeStreams = JSON.parse(output).streams;
    assert.ok(probeStreams.some((stream) => stream.codec_type === 'video'));
    assert.ok(probeStreams.some((stream) => stream.codec_type === 'audio'));
    pass('ffprobe reads video and audio through the embedded backend');
  }
  if (ffmpeg) {
    // Optional developer-side decode check. The installed application uses mpv;
    // this does not stand in for testing that Windows UI/player integration.
    const decoder = spawn(path.resolve(ffmpeg), ['-v', 'error', '-i', play.href, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { windowsHide: true });
    let errors = '';
    decoder.stdout.resume();
    decoder.stderr.on('data', (chunk) => { errors += chunk; });
    const timeout = setTimeout(() => decoder.kill(), 15000);
    const [code] = await once(decoder, 'exit');
    clearTimeout(timeout);
    assert.equal(code, 0, redact(errors));
    pass('FFmpeg decodes the generated video and audio through the embedded backend');
  }
  await shutdown(current);
  pass('explicit shutdown flushes data and releases the listening socket');
  current = launch(await availablePort());
  await ready(current);
  await verifySaved(current, uuid);
  pass('settings and addon survive restart on a different port with the same application-data directory');
  current.child.kill('SIGKILL');
  await waitExit(current);
  current = launch(await availablePort());
  await ready(current);
  await verifySaved(current, uuid);
  pass('SQLite recovery and restart after an abrupt backend crash');
  await shutdown(current, false);
  pass('stdin EOF (parent disconnect) stops the owned backend');
  occupied = createServer((_req, res) => res.end('occupied'));
  const occupiedPort = await listen(occupied);
  current = launch(occupiedPort);
  await waitExit(current, 60000);
  assert.notEqual(current.code, 0, 'Server did not reject an occupied port');
  assert.equal(await (await fetch(`http://127.0.0.1:${occupiedPort}`)).text(), 'occupied');
  pass('port collision fails without attaching to or terminating the unrelated listener');
  console.log(JSON.stringify({ platform: process.platform, node: process.version, checks: completed.length, windowsPlayerTested: false, result: 'passed' }));
} catch (error) {
  console.error(redact(error.stack ?? error));
  if (current?.output) console.error(`Backend diagnostic tail:\n${redact(current.output.slice(-5000))}`);
  process.exitCode = 1;
} finally {
  if (current && !current.exited) { current.child.kill('SIGKILL'); await waitExit(current).catch(() => {}); }
  fixture?.closeAllConnections();
  occupied?.closeAllConnections();
  if (fixture?.listening) await new Promise((resolve) => fixture.close(resolve));
  if (occupied?.listening) await new Promise((resolve) => occupied.close(resolve));
  if (args.includes('--keep-data')) console.log(`Smoke data retained at ${dataRoot}`);
  else await rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
