#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Native Windows WebView2 + mpv check. CDP drives the real native IPC bridge;
// no renderer/player/backend is mocked. Requires a complete staged payload.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, open, readFile, readdir, writeFile } from 'node:fs/promises';
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
let phase = 'test setup';
const results = [];
function pass(message) { results.push(message); console.log(`PASS ${message}`); }
function redact(value, limit = 4096) {
  return String(value ?? '')
    .replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
      try {
        const url = new URL(raw);
        const segments = url.pathname.split('/');
        const sensitive = segments.findIndex(segment => ['proxy', 'stremio', 'jellyfin'].includes(segment));
        const pathname = sensitive >= 0 && segments.length > sensitive + 1
          ? `${segments.slice(0, sensitive + 1).join('/')}/[redacted]`
          : url.pathname;
        return `${url.protocol}//${url.host}${pathname}${url.search ? '?[redacted]' : ''}`;
      } catch { return '[redacted URL]'; }
    })
    .replace(/(__desktop_token(?:=|%3[dD]))[^&\s"']+/gi, '$1[redacted]')
    .replace(/\b[a-f\d]{48,}\b/gi, '[redacted token]')
    .replace(/((?:authorization|cookie|password|secret|token)\s*[=:]\s*)[^\r\n,;]+/gi, '$1[redacted]')
    .slice(-limit);
}
async function logTail(filename, maximumBytes) {
  const file = await open(filename, 'r');
  try {
    const size = (await file.stat()).size;
    const buffer = Buffer.alloc(Math.min(size, maximumBytes));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return redact(buffer.subarray(0, bytesRead).toString('utf8'), maximumBytes);
  } finally { await file.close(); }
}
async function captureFailure(error) {
  const failure = { results, phase, error: redact(error.message), details: {} };
  try {
    const logDirectory = path.join(data, 'data/logs');
    const files = (await readdir(logDirectory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && /^aiostreams-desktop-[\d-]+\.log$/.test(entry.name))
      .map(entry => entry.name).sort().slice(-2);
    for (const name of files) {
      await writeFile(path.join(evidence, name), await logTail(path.join(logDirectory, name), 32768));
    }
    failure.details.logFiles = files;
  } catch (problem) { failure.details.logError = redact(problem.message); }
  if (connection?.socket.readyState === WebSocket.OPEN) {
    try {
      // The profile belongs to this generated fixture. Collect only diagnostic
      // scalars, never URLs, track objects, cookies, storage or arbitrary state.
      const events = await connection.evaluate(`(window.__nativeEvents || []).slice(-20).map(message => Object.fromEntries(['type','positionMs','paused','idle','buffering','seeking','message'].filter(key => typeof message[key] === 'string' || typeof message[key] === 'number' || typeof message[key] === 'boolean').map(key => [key, message[key]])))`);
      failure.details.events = Array.isArray(events) ? events.map(event => Object.fromEntries(
        Object.entries(event).map(([key, value]) => [key, typeof value === 'string' ? redact(value, 1024) : value]),
      )) : [];
    } catch (problem) { failure.details.eventError = redact(problem.message); }
    try {
      const screenshot = await connection.call('Page.captureScreenshot', { format: 'png' });
      await writeFile(path.join(evidence, 'native-failure.png'), Buffer.from(screenshot.data, 'base64'));
      failure.details.screenshot = 'native-failure.png';
    } catch (problem) { failure.details.screenshotError = redact(problem.message); }
  }
  await writeFile(path.join(evidence, 'native-failure.json'), JSON.stringify(failure, null, 2));
}
async function install(executable) {
  phase = 'install or upgrade';
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
  phase = label;
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
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error('CDP WebSocket handshake timed out after 15 seconds'));
      }, 15000);
      socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('CDP WebSocket connection failed')); }, { once: true });
      socket.addEventListener('close', () => { clearTimeout(timeout); reject(new Error('CDP WebSocket closed before connecting')); }, { once: true });
    });
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
    if (result.exceptionDetails) throw new Error(redact(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text));
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
  phase = 'native app shutdown';
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
  // First run: the AIOStreams account setup (AIOSTREAMS_AUTH) appears first.
  await until(() => connection.evaluate('!!document.getElementById("account-setup-title")'), 'first-run account setup screen');
  const fill = (selector, value) => connection.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await fill('input[autocomplete="username"]', 'native user');
  await fill('#account-password-0', 'native-pass-1');
  await fill('#account-confirm-0', 'different-pass');
  await connection.evaluate('document.querySelector("form button[type=submit]").click(), true');
  await until(() => connection.evaluate('!!document.querySelector("[role=alert]")?.innerText.includes("do not match")'), 'password mismatch is refused');
  await fill('#account-confirm-0', 'native-pass-1');
  await connection.evaluate('document.querySelector("form button[type=submit]").click(), true');
  pass('native WebView2 client shows first-run account setup and refuses mismatched passwords');
  // Saving restarts the backend with AIOSTREAMS_AUTH, which reloads the page.
  await until(() => connection.evaluate('document.body.innerText.includes("Your account is ready")'), 'account accepted by the built-in Usenet check', 240000);
  base = await connection.evaluate('location.origin');
  await connection.evaluate('window.__nativeEvents=[]; window.aiostreamsApp.subscribe(message=>window.__nativeEvents.push(message)); true');
  const created = await connection.evaluate("fetch('/__desktop/accounts').then(r=>r.json())");
  assert.deepEqual(created.accounts.map((a) => a.username), ['native user']);
  const accepted = await connection.evaluate(`fetch('/__desktop/account-check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({credential:'native user:native-pass-1'})}).then(r=>r.json())`);
  assert.equal(accepted.success, true);
  pass('account saved with DPAPI, applied as AIOSTREAMS_AUTH after restart and accepted by the Usenet service check');
  // "Open Usenet providers" opens upstream's dashboard over the library.
  await connection.evaluate('[...document.querySelectorAll("button")].find(b => b.innerText.includes("Open Usenet providers")).click(), true');
  const browseEntry = 'document.querySelector("[role=dialog] iframe")?.contentDocument?.querySelector("[data-vertical-menu-item-button=Browse]")';
  await until(() => connection.evaluate(`!!${browseEntry}`), 'dashboard panel with Browse entry', 60000);
  pass('real dashboard opens in the panel with its Browse sidebar entry');
  await connection.evaluate("window.__panelMessages=[]; window.addEventListener('message', e => window.__panelMessages.push({ origin: e.origin, data: e.data })); true");
  await connection.evaluate(`${browseEntry}.click(), true`);
  try {
    await until(() => connection.evaluate('!document.querySelector("[role=dialog] iframe")'), 'Browse closes the panel', 15000);
  } catch (error) {
    const detail = await connection.evaluate(`JSON.stringify({ messages: window.__panelMessages, entries: document.querySelector("[role=dialog] iframe")?.contentDocument?.querySelectorAll("[data-vertical-menu-item-button=Browse]").length, path: document.querySelector("[role=dialog] iframe")?.contentWindow?.location.pathname, inPanel: document.querySelector("[role=dialog] iframe")?.contentWindow?.parent === window })`).catch(() => 'unavailable');
    throw new Error(`${error.message}; panel state ${detail}`);
  }
  // Ctrl+, opens it; typing in a field never does; Escape closes it.
  await connection.evaluate("(() => { const input = document.createElement('input'); document.body.append(input); input.focus(); input.dispatchEvent(new KeyboardEvent('keydown', { key: ',', code: 'Comma', ctrlKey: true, bubbles: true })); input.remove(); return true; })()");
  await delay(500);
  assert.equal(await connection.evaluate('!!document.querySelector("[role=dialog] iframe")'), false, 'Shortcut fired while typing');
  await connection.evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', code: 'Comma', ctrlKey: true, bubbles: true })), true");
  await until(() => connection.evaluate('!!document.querySelector("[role=dialog] iframe")'), 'Ctrl+, opens the dashboard');
  await connection.evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true");
  await until(() => connection.evaluate('!document.querySelector("[role=dialog] iframe")'), 'Escape returns to the library');
  assert.equal(await connection.evaluate('!!document.querySelector("nav[aria-label=\\"Desktop navigation\\"]")'), false, 'Old floating navigation is still present');
  pass('Browse, Ctrl+, and Escape navigation; no shortcut while typing; no floating navigation bar');
  await connection.evaluate('[...document.querySelectorAll("button")].find(b => b.innerText.includes("Ready to browse"))?.click(), true');
  const duplicate = spawn(path.join(stage, 'aiostreams-desktop.exe'), [], { cwd: stage, stdio: 'ignore', env: { ...process.env, AIOSTREAMS_DESKTOP_DATA_DIR: data } });
  const duplicateCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { duplicate.kill(); reject(new Error('Second app instance did not exit')); }, 15000);
    duplicate.once('error', error => { clearTimeout(timeout); reject(error); });
    duplicate.once('exit', code => { clearTimeout(timeout); resolve(code); });
  });
  assert.equal(duplicateCode, 0);
  pass('second native app launch exits through the single-instance guard');
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
  const tracks = await connection.evaluate('window.__nativeEvents.filter(m=>m.type==="player-tracks").at(-1).tracks');
  const audio = tracks.find(track => track.type === 'audio');
  const subtitle = tracks.find(track => track.type === 'subtitle');
  assert.ok(audio && subtitle, 'Expected decoded audio and subtitle tracks');
  await connection.evaluate("window.__nativeEvents=[]; window.aiostreamsApp.send({type:'player-set',audio:null,subtitle:null}); true");
  await until(() => connection.evaluate("window.__nativeEvents.some(m=>m.type==='player-state' && m.audio===null) && window.__nativeEvents.some(m=>m.type==='player-state' && m.subtitle===null)"), 'disable audio/subtitle tracks');
  await connection.evaluate(`window.__nativeEvents=[]; window.aiostreamsApp.send({type:'player-set',audio:${JSON.stringify(audio.id)},subtitle:${JSON.stringify(subtitle.id)}}); true`);
  await until(() => connection.evaluate(`window.__nativeEvents.some(m=>m.type==='player-state' && m.audio===${JSON.stringify(audio.id)}) && window.__nativeEvents.some(m=>m.type==='player-state' && m.subtitle===${JSON.stringify(subtitle.id)})`), 'audio/subtitle selection');
  pass('native pause, seek, audio selection and subtitle controls');
  const screenshot = await connection.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(evidence, 'native-webview.png'), Buffer.from(screenshot.data, 'base64'));
  await connection.evaluate('window.__nativeSessionMarker="before-restart"; window.aiostreamsApp.send({type:"backend-restart"}); true');
  await until(() => connection.evaluate('window.__nativeSessionMarker!=="before-restart" && location.pathname.startsWith("/__desktop/client") && !!window.aiostreamsApp && fetch("/api/v1/health").then(r=>r.ok)'), 'native backend restart and client reconnection', 240000);
  base = await connection.evaluate('location.origin');
  pass('native restart action reconnects the client to its healthy backend');
  await closeApp(base);
  pass('native app exit releases the backend socket');
  if (upgrade) { await install(upgrade); pass('newer integrated installer upgrades the same installation'); }
  base = await launch();
  const saved = await connection.evaluate("fetch('/api/v1/dashboard/settings/export').then(r=>r.json())");
  assert.equal(saved.data.settings['branding.addonName'], 'Native smoke 空間');
  pass('second native launch decrypts saved DPAPI key and retains server configuration');
  const kept = await connection.evaluate("fetch('/__desktop/accounts').then(r=>r.json())");
  assert.deepEqual(kept.accounts.map((a) => a.username), ['native user']);
  assert.equal(await connection.evaluate('!!document.getElementById("account-setup-title")'), false, 'Account setup shown again for an existing account');
  pass('AIOStreams account survives restart and upgrade; setup is not shown again');
  await closeApp(base);
  await writeFile(path.join(evidence, 'native-results.json'), JSON.stringify({ platform: process.platform, results, realNativeBridge: true, audioOutput: 'null (CI has no physical speaker)', installationTested: !!installer, upgradeTested: !!upgrade, developerToolsInChildPath: false }, null, 2));
} catch (error) {
  await captureFailure(error).catch(problem => console.error(`Failure evidence could not be written: ${redact(problem.message)}`));
  throw new Error(redact(error.message));
} finally {
  connection?.socket.close();
  if (child?.exitCode === null) { child.kill(); await delay(1000); }
  await new Promise(resolve => fixture.close(resolve));
}
