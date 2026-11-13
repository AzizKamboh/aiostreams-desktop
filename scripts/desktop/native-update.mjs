#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Native Windows update test for the integrated app. Installs a real package,
// serves real Velopack feeds from a local fixture server and drives the real
// updater through the app's own bridge (CDP into WebView2). Nothing is mocked:
// Velopack checks, downloads, verifies and installs, and the app restarts.
//
//   node native-update.mjs --installer <Setup.exe> --feed <dir> --next-feed <dir>
//        [--portable <Portable.zip>] [--evidence <dir>]
//
// <dir> is `vpk pack` output for a newer version than the installer (the
// "update"), <next-feed> for a newer one still (the "install and restart" step).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.platform, 'win32', 'Run this test on native Windows');
const here = path.dirname(fileURLToPath(import.meta.url));
const option = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const installer = path.resolve(option('--installer') ?? assert.fail('--installer is required'));
const feedDir = path.resolve(option('--feed') ?? assert.fail('--feed is required'));
const nextFeedDir = path.resolve(option('--next-feed') ?? assert.fail('--next-feed is required'));
const portableZip = option('--portable') && path.resolve(option('--portable'));
const evidence = path.resolve(option('--evidence') ?? '.embedded-build/native-evidence');
const CHANNEL = 'win-x64';
await mkdir(evidence, { recursive: true });

// --- Fixture feed: one server, switchable between healthy and broken feeds.
async function loadFeed(dir) {
  const json = JSON.parse(await readFile(path.join(dir, `releases.${CHANNEL}.json`), 'utf8'));
  const full = json.Assets.find((a) => /^full$/i.test(a.Type));
  return { dir, json, full, version: full.Version };
}
const update = await loadFeed(feedDir);
const next = await loadFeed(nextFeedDir);
let mode = 'missing';
let packageRequests = 0;
const server = createServer(async (req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://feed').pathname.split('/').pop());
  const send = (status, body, type = 'application/octet-stream') => { res.writeHead(status, { 'Content-Type': type }); res.end(body); };
  const feed = mode === 'next' ? next : update;
  if (mode === 'missing') return send(404, 'not found');
  if (mode === 'down') return send(503, 'unavailable');
  if (name === `releases.${CHANNEL}.json`) {
    let json = structuredClone(feed.json);
    if (mode === 'foreign') json.Assets = json.Assets.map((a) => ({ ...a, PackageId: 'aiostreams-desktop' }));
    if (mode === 'older') json.Assets = json.Assets.filter((a) => /^full$/i.test(a.Type)).map((a) => ({ ...a, Version: '0.0.1' }));
    if (mode === 'malformed') return send(200, '{"Assets": [ this is not json', 'application/json');
    return send(200, JSON.stringify(json), 'application/json');
  }
  if (name.endsWith('.nupkg') && /^[A-Za-z0-9._-]+$/.test(name)) {
    packageRequests++;
    try {
      const bytes = await readFile(path.join(feed.dir, name));
      if (mode === 'corrupt') bytes[Math.floor(bytes.length / 2)] ^= 0xff;
      return send(200, bytes);
    } catch { return send(404, 'no such package'); }
  }
  send(404, 'not found');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const feedUrl = `http://127.0.0.1:${server.address().port}/feed/`;

// --- App control (same approach as native-smoke.mjs).
const data = await mkdtemp(path.join(tmpdir(), 'AIOStreams update 空間 '));
const installRoot = path.join(await mkdtemp(path.join(tmpdir(), 'AIOStreams update install 空間 ')), 'application');
await mkdir(path.join(data, 'config/mpv'), { recursive: true });
await writeFile(path.join(data, 'config/mpv/mpv.conf'), 'ao=null\nloop-file=inf\nd3d11-warp=yes\n');
await mkdir(path.join(data, 'data/backend/data/seadex'), { recursive: true });
await writeFile(path.join(data, 'data/backend/data/seadex/trs.json'), JSON.stringify({ torrentsByAnilistId: {}, lastUpdated: Date.now() }));
const media = await readFile(path.join(here, 'fixtures/test-pattern.mp4'));
const mediaServer = createServer((req, res) => {
  const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
  const start = match ? Number(match[1]) : 0;
  const end = match?.[2] ? Math.min(Number(match[2]), media.length - 1) : media.length - 1;
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', end - start + 1);
  if (match) { res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${media.length}`); }
  res.end(media.subarray(start, end + 1));
});
await new Promise((resolve) => mediaServer.listen(0, '127.0.0.1', resolve));
const mediaUrl = `http://127.0.0.1:${mediaServer.address().port}/sample.mp4`;
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const debugPort = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));

let child;
let connection;
let phase = 'setup';
const results = [];
const pass = (message) => { results.push(message); console.log(`PASS ${message}`); };

async function until(check, label, milliseconds = 60000) {
  phase = label;
  const deadline = Date.now() + milliseconds;
  let last;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await delay(250);
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
class CDP {
  constructor(socket) {
    this.socket = socket; this.id = 0; this.pending = new Map();
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP connection failed')), { once: true });
    });
    return new CDP(socket);
  }
  call(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timeout); resolve(v); }, reject: (e) => { clearTimeout(timeout); reject(e); } });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
}
function installedVersion(root) {
  const manifest = path.join(root, 'current', 'sq.version');
  if (!existsSync(manifest)) return null;
  return /<version>([^<]+)<\/version>/.exec(readFileSync(manifest, 'utf8'))?.[1] ?? null;
}
/** Processes started from an install root (Velopack's restart starts one). */
function processesUnder(root) {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='aiostreams-desktop.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${root.replace(/'/g, "''")}', 'OrdinalIgnoreCase') } | ForEach-Object { $_.ProcessId }`]).toString();
  return out.split(/\s+/).filter(Boolean).map(Number);
}
async function launch(appDir) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  child = spawn(path.join(appDir, 'aiostreams-desktop.exe'), ['--remote-debugging-port', String(debugPort)], {
    cwd: appDir, stdio: 'ignore', env: { ...inherited,
      Path: `${process.env.SystemRoot}/system32;${process.env.SystemRoot}`,
      AIOSTREAMS_DESKTOP_DATA_DIR: data, AIOSTREAMS_UPDATE_FEED: feedUrl, ALLOW_PRIVATE_URLS: 'true',
      ANIME_DB_LEVEL_OF_DETAIL: 'none', ID_MAPPINGS_ENABLED: 'false', SCENE_MAPPINGS_ENABLED: 'false',
      TITLE_CONFLICTS_ENABLED: 'false', TEMPLATE_URLS: '[]', COMMUNITY_REMOTE_SOURCES: '[]',
      WATCH_STATE_REPORT_ENABLED: 'false', WATCH_STATE_PULL_ENABLED: 'false',
    },
  });
  const target = await until(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1000) });
    return (await response.json()).find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
  }, 'WebView2 debugging endpoint', 90000);
  connection = await CDP.connect(target.webSocketDebuggerUrl);
  await until(() => connection.evaluate('location.pathname.startsWith("/__desktop/client") && !!window.aiostreamsApp'), 'embedded client', 240000);
  await connection.evaluate(`window.__updates=[]; window.__events=[]; window.aiostreamsApp.subscribe(m => { window.__events.push(m); if (m.type === 'integrated-update-state') window.__updates.push(m); }); true`);
  return connection.evaluate('location.origin');
}
/** Sends an integrated-update message and waits for a state matching `accept`. */
async function updateState(type, accept, label, extra = {}, milliseconds = 120000) {
  await connection.evaluate(`window.__updates=[]; window.aiostreamsApp.send(${JSON.stringify({ type, ...extra })}); true`);
  return until(async () => {
    await connection.evaluate(`window.aiostreamsApp.send({type:'integrated-update-status'}); true`);
    const states = await connection.evaluate('window.__updates.slice(-5)');
    return states.reverse().find(accept);
  }, label, milliseconds);
}
async function waitExit(label) {
  phase = label;
  for (let i = 0; i < 300 && child.exitCode === null; i++) await delay(100);
  assert.notEqual(child.exitCode, null, `${label}: the app did not exit`);
  assert.equal(child.exitCode, 0, `${label}: the app exited unsuccessfully`);
  connection.socket.close();
  connection = null;
}
const healthy = (base) => fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok);
const packagesHave = async (root, version) => (await readdir(path.join(root, 'packages')).catch(() => [])).some((name) => name.includes(`-${version}-`) && name.endsWith('.nupkg'));

try {
  phase = 'install';
  const setup = spawn(installer, ['--silent', '--installto', installRoot], { stdio: 'ignore' });
  assert.equal(await new Promise((resolve) => setup.once('exit', resolve)), 0, 'Installer failed');
  const original = installedVersion(installRoot);
  assert.ok(original, 'No installed manifest');
  pass(`installed ${original} into a spaced Unicode path`);

  let base = await launch(path.join(installRoot, 'current'));
  // Data that must survive every update: server settings and an account.
  const imported = await connection.evaluate(`fetch('/api/v1/dashboard/settings/import/json',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({settings:{'branding.addonName':'Update test 空間'}})}).then(r=>r.json())`);
  assert.equal(imported.success, true, 'Could not save server settings');
  const first = await updateState('integrated-update-status', (s) => s.state !== 'off', 'updater running');
  assert.equal(first.installedVersion, original);
  assert.equal(first.feed, feedUrl);
  assert.equal(first.channel, 'stable');
  pass('the installed app runs its updater on the stable channel and the configured feed');

  for (const [m, pattern, label] of [
    ['missing', /404/, 'missing update feed'],
    ['down', /503/, 'update server temporarily unavailable'],
    ['malformed', /\S/, 'malformed release metadata'],
    ['foreign', /refused: .*aiostreams-desktop/, 'feed offering a different package identity'],
    ['corrupt', /checksum/i, 'corrupted package download'],
  ]) {
    mode = m;
    // Only a state from a new check counts, never the previous scenario's.
    const checks = (await updateState('integrated-update-status', () => true, 'status')).checks ?? 0;
    const state = await updateState('integrated-update-check', (s) => s.state === 'error' && s.checks > checks && pattern.test(s.lastError ?? ''), label);
    assert.ok(await healthy(base), `${label}: the local server stopped working`);
    assert.equal(await packagesHave(installRoot, update.version), false, `${label}: a package was kept`);
    pass(`${label}: reported (${state.lastError.slice(0, 80)}), nothing installed, app keeps working`);
  }
  assert.ok(packageRequests > 0, 'The corrupt scenario never downloaded');
  mode = 'older';
  const olderFrom = (await updateState('integrated-update-status', () => true, 'status')).checks ?? 0;
  await updateState('integrated-update-check', (s) => s.state === 'current' && s.checks > olderFrom, 'feed offering only an older version');
  pass('an older version on the feed is never installed (no downgrade)');
  await connection.evaluate(`window.aiostreamsApp.send({type:'update-check',channel:'bogus'}); true`);
  await delay(1000);
  assert.ok(await healthy(base));
  pass('an invalid channel request is ignored');

  mode = 'good';
  const ready = await updateState('integrated-update-check', (s) => s.state === 'ready', 'successful download', {}, 300000);
  assert.equal(ready.readyVersion, update.version);
  assert.ok(ready.releaseNotesUrl === null || ready.releaseNotesUrl === undefined || ready.releaseNotesUrl.includes(`/releases/tag/v${update.version}`));
  assert.ok(await packagesHave(installRoot, update.version), 'The verified package is not in the packages folder');
  pass(`update ${update.version} found, downloaded and verified in the background`);

  // Playback: an install request without consent must not stop it.
  const playable = await connection.evaluate(`fetch('/api/v1/proxy/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:${JSON.stringify(mediaUrl)},filename:'sample.mp4',type:'stream'})}).then(r=>r.json())`);
  await connection.evaluate(`window.__events=[]; window.aiostreamsApp.send({type:'player-load',url:${JSON.stringify(playable.proxified_url)}}); true`);
  await until(() => connection.evaluate('window.__events.some(m=>m.type==="player-state" && m.positionMs>200)'), 'playback advancing');
  const refused = await updateState('integrated-update-install', (s) => s.refused === 'playing', 'install refused during playback', { confirmed: false });
  assert.equal(refused.playing, true);
  await connection.evaluate('window.__events=[]; true');
  await until(() => connection.evaluate('window.__events.some(m=>m.type==="player-state" && m.positionMs>0)'), 'playback continues after the refused install');
  assert.equal(child.exitCode, null);
  pass('with an update ready, playback is never interrupted without consent');
  await connection.evaluate(`window.aiostreamsApp.send({type:'player-stop'}); true`);

  // Closing the app installs the update (no restart), after the server stopped.
  await connection.evaluate(`window.aiostreamsApp.send({type:'close'}); true`);
  await waitExit('close with an update ready');
  await assert.rejects(fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(1500) }));
  await until(() => installedVersion(installRoot) === update.version, `update ${update.version} installed after exit`, 180000);
  // Velopack runs the new version briefly for its update hook, which exits; nothing may keep running.
  await until(async () => { if (processesUnder(installRoot).length) return false; await delay(5000); return processesUnder(installRoot).length === 0; }, 'no app restart after a plain close', 60000);
  pass(`closing the app stops the server gracefully and installs ${update.version}`);

  base = await launch(path.join(installRoot, 'current'));
  const after = await updateState('integrated-update-status', (s) => s.state !== 'off', 'updater after the update');
  assert.equal(after.installedVersion, update.version);
  const settings = await connection.evaluate("fetch('/api/v1/dashboard/settings/export').then(r=>r.json())");
  assert.equal(settings.data.settings['branding.addonName'], 'Update test 空間');
  pass('after the update the DPAPI key, database and server settings are intact');

  // Install and restart: the app closes normally and Velopack starts the new version.
  mode = 'next';
  await updateState('integrated-update-check', (s) => s.state === 'ready' && s.readyVersion === next.version, 'next update ready', {}, 300000);
  await connection.evaluate(`window.aiostreamsApp.send({type:'integrated-update-install',confirmed:true}); true`);
  await waitExit('install and restart');
  await until(() => installedVersion(installRoot) === next.version, `update ${next.version} installed`, 180000);
  const restarted = await until(() => { const ids = processesUnder(installRoot); return ids.length ? ids : null; }, 'Velopack restarts the updated app', 120000);
  pass(`Install and restart closes the app, installs ${next.version} and starts it again`);
  for (const id of restarted) execFileSync('taskkill', ['/PID', String(id), '/T', '/F'], { stdio: 'ignore' });
  await delay(3000);

  if (portableZip) {
    phase = 'portable';
    const portableRoot = path.join(await mkdtemp(path.join(tmpdir(), 'AIOStreams portable 空間 ')), 'AIOStreams');
    await mkdir(portableRoot, { recursive: true });
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${portableZip.replace(/'/g, "''")}' -DestinationPath '${portableRoot.replace(/'/g, "''")}'`]);
    const before = installedVersion(portableRoot);
    mode = 'good';
    await launch(path.join(portableRoot, 'current'));
    const portable = await updateState('integrated-update-check', (s) => s.state === 'ready', 'portable update download', {}, 300000);
    assert.equal(portable.portable, true);
    await connection.evaluate(`window.aiostreamsApp.send({type:'close'}); true`);
    await waitExit('portable close');
    await until(() => installedVersion(portableRoot) === update.version, 'portable copy updated in place', 180000);
    pass(`portable copy ${before} updates itself in place to ${update.version}`);
  }
  await writeFile(path.join(evidence, 'native-update-results.json'), JSON.stringify({ results, feedVersions: [update.version, next.version], portableTested: !!portableZip }, null, 2));
} catch (error) {
  await writeFile(path.join(evidence, 'native-update-failure.json'), JSON.stringify({ phase, message: error.message, results }, null, 2)).catch(() => {});
  if (connection) {
    const shot = await connection.call('Page.captureScreenshot', { format: 'png' }).catch(() => null);
    if (shot) await writeFile(path.join(evidence, 'native-update-failure.png'), Buffer.from(shot.data, 'base64'));
  }
  throw error;
} finally {
  connection?.socket.close();
  if (child?.exitCode === null) { child.kill(); await delay(1000); }
  for (const id of processesUnder(installRoot)) { try { execFileSync('taskkill', ['/PID', String(id), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
  server.close();
  mediaServer.close();
}
