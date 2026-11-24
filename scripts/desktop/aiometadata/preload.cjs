// SPDX-License-Identifier: AGPL-3.0-only
// Loaded with `node -r` before the bundled AIOMetadata server (integration-owned;
// AIOMetadata itself is unmodified). It adapts a Docker-shaped server to a
// per-user desktop process:
//
// - AIOMetadata resolves its code (package.json, dist, public) and its data
//   (addon/data) from process.cwd(). The install folder is replaced by every
//   update, so the working directory is the per-user data folder and the code
//   root is supplied here by seeding the module that computes it.
// - Every listener binds to 127.0.0.1: the server is private to this computer
//   and must never be reachable from the network or trigger a firewall prompt.
// - Windows cannot deliver SIGTERM to a child, so the app asks for a shutdown
//   on stdin (or closes stdin) and AIOMetadata's own graceful shutdown runs.
'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const Module = require('node:module');

const appRoot = process.env.AIOMETADATA_DESKTOP_APP_ROOT;
if (!appRoot || !path.isAbsolute(appRoot)) {
  process.stderr.write('aiometadata-desktop: AIOMETADATA_DESKTOP_APP_ROOT must be an absolute path\n');
  process.exit(78);
}

// 1. Code root.
const runtimePaths = path.join(appRoot, 'dist', 'server', 'lib', 'runtimePaths.js');
if (!fs.existsSync(runtimePaths) || !fs.existsSync(path.join(appRoot, 'package.json'))) {
  process.stderr.write('aiometadata-desktop: Cannot find module runtimePaths in the bundled AIOMetadata\n');
  process.exit(78);
}
const seeded = new Module(runtimePaths, null);
seeded.filename = runtimePaths;
seeded.paths = Module._nodeModulePaths(path.dirname(runtimePaths));
seeded.loaded = true;
seeded.exports = {
  appRoot,
  clientDistDir: path.join(appRoot, 'dist', 'client'),
  clientIndexPath: path.join(appRoot, 'dist', 'client', 'index.html'),
  publicDir: path.join(appRoot, 'public'),
};
require.cache[runtimePaths] = seeded;
fs.mkdirSync(path.join(process.cwd(), 'addon', 'data'), { recursive: true });

// 2. Loopback only.
const LOOPBACK = '127.0.0.1';
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function listenOnLoopback(...args) {
  const first = args[0];
  if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
    // listen({ port, host }) or listen(handle); pipes and handles are local already.
    if (first.path === undefined && first.fd === undefined && first._handle === undefined && first.handle === undefined) {
      args[0] = { ...first, host: LOOPBACK };
    }
  } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    // listen(port[, host][, backlog][, callback])
    if (typeof args[1] === 'string') args[1] = LOOPBACK;
    else args.splice(1, 0, LOOPBACK);
  } else if (first === undefined || typeof first === 'function') {
    // listen([callback]): a random port on every interface by default.
    args.unshift(0, LOOPBACK);
  }
  return listen.apply(this, args);
};

// 3. Graceful shutdown requested by the app.
if (process.env.AIOMETADATA_DESKTOP_STDIN_CONTROL === '1') {
  let requested = false;
  const shutdown = () => {
    if (requested) return;
    requested = true;
    process.emit('SIGTERM', 'SIGTERM');
  };
  let pending = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end).trim();
      pending = pending.slice(end + 1);
      try {
        if (JSON.parse(line).command === 'shutdown') shutdown();
      } catch {
        /* not a control message */
      }
    }
    if (pending.length > 4096) pending = '';
  });
  process.stdin.on('end', shutdown);
  process.stdin.on('error', shutdown);
}
