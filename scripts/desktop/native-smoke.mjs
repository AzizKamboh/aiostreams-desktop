#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Native Windows WebView2 + mpv check. CDP drives the real native IPC bridge;
// no renderer/player/backend is mocked. Requires a complete staged payload.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.platform, 'win32', 'Run this test on native Windows');
const here = path.dirname(fileURLToPath(import.meta.url));
let stage = path.resolve(process.argv[2] ?? '.embedded-build/stage');
const evidence = path.resolve(process.argv[3] ?? '.embedded-build/native-evidence');
const data = await mkdtemp(path.join(tmpdir(), 'AIOStreams native 空間 '));
const option = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const installer = option('--installer');
const upgrade = option('--upgrade');
const installRoot = installer ? path.join(await mkdtemp(path.join(tmpdir(), 'AIOStreams install 空間 ')), 'application') : null;
await mkdir(evidence, { recursive: true });
await mkdir(path.join(data, 'config/mpv'), { recursive: true });
// Hosted CI has no physical speaker. Audio still decodes; output goes to null.
await writeFile(path.join(data, 'config/mpv/mpv.conf'), 'ao=null\nloop-file=inf\nd3d11-warp=yes\n');
await mkdir(path.join(data, 'data/backend/data/seadex'), { recursive: true });
await writeFile(path.join(data, 'data/backend/data/seadex/trs.json'), JSON.stringify({ torrentsByAnilistId: {}, lastUpdated: Date.now() }));
const media = await readFile(path.join(here, 'fixtures/test-pattern.mp4'));
let mediaRequests = 0;
const fixture = createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/captions.srt') {
    res.setHeader('Content-Type', 'application/x-subrip');
    res.end('1\n00:00:00,000 --> 00:00:02,000\nNative playback fixture\n');
  } else if (url.pathname === '/sample.mp4') {
    mediaRequests++;
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), media.length - 1) : media.length - 1;
    if (start >= media.length) { res.writeHead(416); res.end(); return; }
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', end - start + 1);
    if (match) { res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${media.length}`); }
    res.end(req.method === 'HEAD' ? undefined : media.subarray(start, end + 1));
  } else { res.writeHead(404); res.end(); }
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const fixtureBase = `http://127.0.0.1:${fixture.address().port}`;
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const debugPort = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
let child;
let connection;
const results = [];
function pass(message) { results.push(message); console.log(`PASS ${message}`); }
async function install(executable) {
  const setup = spawn(path.resolve(executable), ['--silent', '--installto', installRoot], { stdio: 'ignore' });
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { setup.kill(); reject(new Error('Installer timed out')); }, 180000);
    setup.once('error', error => { clearTimeout(timeout); reject(error); });
    setup.once('exit', code => { clearTimeout(timeout); resolve(code); });
  });
  assert.equal(code, 0, 'Installer exited unsuccessfully');
  stage = path.join(installRoot, 'current');
}
async function until(check, label, milliseconds = 30000) {
  const deadline = Date.now() + milliseconds;
  let last;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(`Native app exited (${child.exitCode}) while waiting for ${label}`);
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await delay(150);
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
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    return new CDP(socket);
  }
  call(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      this.pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
}
async function launch() {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  child = spawn(path.join(stage, 'aiostreams-desktop.exe'), ['--remote-debugging-port', String(debugPort)], {
    cwd: stage, stdio: 'ignore', env: { ...inherited,
      Path: `${process.env.SystemRoot}/system32;${process.env.SystemRoot}`,
      AIOSTREAMS_DESKTOP_DATA_DIR: data, ALLOW_PRIVATE_URLS: 'true',
      ANIME_DB_LEVEL_OF_DETAIL: 'none', ID_MAPPINGS_ENABLED: 'false',
      SCENE_MAPPINGS_ENABLED: 'false', TITLE_CONFLICTS_ENABLED: 'false',
      TEMPLATE_URLS: '[]', COMMUNITY_REMOTE_SOURCES: '[]',
      WATCH_STATE_REPORT_ENABLED: 'false', WATCH_STATE_PULL_ENABLED: 'false',
    },
  });
  child.on('error', error => console.error(`Native launch error: ${error.message}`));
  const target = await until(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1000) });
    return (await response.json()).find(item => item.type === 'page' && item.webSocketDebuggerUrl);
  }, 'WebView2 debugging endpoint', 90000);
  connection = await CDP.connect(target.webSocketDebuggerUrl);
  await until(() => connection.evaluate('location.pathname.startsWith("/__desktop/client") && !!window.aiostreamsApp'), 'native embedded client', 240000);
  await connection.evaluate('window.__nativeEvents=[]; window.aiostreamsApp.subscribe(message=>window.__nativeEvents.push(message)); true');
  return connection.evaluate('location.origin');
}
async function closeApp(base) {
  await connection.evaluate('window.aiostreamsApp.send({type:"close"}); true').catch(() => {});
  for (let i = 0; i < 150 && child.exitCode === null; i++) await delay(100);
  assert.notEqual(child.exitCode, null, 'Native app did not exit');
  assert.equal(child.exitCode, 0, 'Native app exited unsuccessfully');
  connection.socket.close();
  connection = null;
  await assert.rejects(fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(1500) }));
}
try {
  if (installer) { await install(installer); pass('per-user installer runs successfully into a spaced Unicode path'); }
  let base = await launch();
  await until(() => connection.evaluate('document.querySelector("iframe")?.contentDocument?.body?.innerText.includes("AIOStreams")'), 'real configuration dashboard');
  pass('native Windows app, bundled WebView2, private backend and configuration dashboard');
  const configured = await connection.evaluate(`fetch('/api/v1/dashboard/settings/import/json',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({settings:{'branding.addonName':'Native smoke 空間'}})}).then(r=>r.json())`);
  assert.equal(configured.success, true);
  const playable = await connection.evaluate(`fetch('/api/v1/proxy/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:${JSON.stringify(fixtureBase + '/sample.mp4')},filename:'sample.mp4',type:'stream'})}).then(r=>r.json())`);
  assert.ok(playable.proxified_url?.startsWith(base));
  await connection.evaluate(`window.aiostreamsApp.send({type:'player-load',url:${JSON.stringify(playable.proxified_url)}}); true`);
  await until(() => connection.evaluate('window.__nativeEvents.some(m=>m.type==="player-state" && m.positionMs>200)'), 'mpv playback advancing');
  assert.ok(mediaRequests > 0, 'mpv did not request fixture bytes');
  pass('native mpv playback advances through an authenticated embedded-server proxy');
  await connection.evaluate('window.__nativeEvents=[]; window.aiostreamsApp.send({type:"player-set",paused:true}); true');
  await until(() => connection.evaluate('window.__nativeEvents.some(m=>m.type==="player-state" && m.paused===true)'), 'mpv pause');
  await connection.evaluate('window.__nativeEvents=[]; window.aiostreamsApp.send({type:"player-seek",positionMs:700}); true');
  await until(() => connection.evaluate('window.__nativeEvents.some(m=>m.type==="player-state" && m.positionMs>=600)'), 'mpv seek');
  await connection.evaluate(`window.aiostreamsApp.send({type:'player-subtitle-add',url:${JSON.stringify(fixtureBase + '/captions.srt')},title:'Fixture captions',language:'en'}); true`);
  await until(() => connection.evaluate('window.__nativeEvents.some(m=>m.type==="player-tracks" && m.tracks.some(t=>t.type==="subtitle"))'), 'subtitle track');
  pass('native pause, seek and subtitle track controls');
  const screenshot = await connection.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(evidence, 'native-webview.png'), Buffer.from(screenshot.data, 'base64'));
  await closeApp(base);
  pass('native app exit releases the backend socket');
  if (upgrade) { await install(upgrade); pass('newer integrated installer upgrades the same installation'); }
  base = await launch();
  const saved = await connection.evaluate("fetch('/api/v1/dashboard/settings/export').then(r=>r.json())");
  assert.equal(saved.data.settings['branding.addonName'], 'Native smoke 空間');
  pass('second native launch decrypts saved DPAPI key and retains server configuration');
  await closeApp(base);
  await writeFile(path.join(evidence, 'native-results.json'), JSON.stringify({ platform: process.platform, results, realNativeBridge: true, audioOutput: 'null (CI has no physical speaker)', installationTested: !!installer, upgradeTested: !!upgrade, developerToolsInChildPath: false }, null, 2));
} catch (error) {
  await writeFile(path.join(evidence, 'native-failure.json'), JSON.stringify({ results, error: error.message }, null, 2));
  throw error;
} finally {
  connection?.socket.close();
  if (child?.exitCode === null) { child.kill(); await delay(1000); }
  await new Promise(resolve => fixture.close(resolve));
}
