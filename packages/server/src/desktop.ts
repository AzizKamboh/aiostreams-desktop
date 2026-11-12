/** Optional private-desktop boundary. The regular hosted server is unchanged. */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { RequestHandler, Request, Response } from 'express';

export const DESKTOP_COOKIE = 'aiostreams.desktop';
export const DESKTOP_HEADER = 'x-aiostreams-desktop-token';
export const DESKTOP_QUERY = '__desktop_token';

export interface DesktopOptions {
  token: string;
  origin: string;
  host: string;
}

export function desktopOptions(
  env: NodeJS.ProcessEnv
): DesktopOptions | undefined {
  const token = env.AIOSTREAMS_DESKTOP_TOKEN;
  if (token === undefined) return undefined;
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    throw new Error(
      'AIOSTREAMS_DESKTOP_TOKEN must be a random 64-character hex token'
    );
  }
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      'Desktop mode requires an explicit PORT between 1 and 65535'
    );
  }
  const origin = `http://127.0.0.1:${port}`;
  if (env.BASE_URL !== origin || env.INTERNAL_URL !== origin) {
    throw new Error(
      'Desktop BASE_URL and INTERNAL_URL must match the selected loopback port'
    );
  }
  return { token, origin, host: `127.0.0.1:${port}` };
}

function equal(value: string | undefined, secret: string): boolean {
  if (!value || value.length !== secret.length) return false;
  const candidate = Buffer.from(value);
  const expected = Buffer.from(secret);
  return (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
}

function cookieValue(req: IncomingMessage): string | undefined {
  return req.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${DESKTOP_COOKIE}=`))
    ?.slice(DESKTOP_COOKIE.length + 1);
}

/** Host validation defeats DNS rebinding; Origin validation blocks browser CSRF. */
export function desktopAuthorised(
  req: IncomingMessage,
  options: DesktopOptions,
  internalHeader?: string,
  internalSecret?: string
): boolean {
  if (req.headers.host !== options.host) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== options.origin) return false;
  let url: URL;
  try {
    url = new URL(req.url || '/', options.origin);
  } catch {
    return false;
  }
  const header = req.headers[DESKTOP_HEADER];
  return (
    equal(typeof header === 'string' ? header : undefined, options.token) ||
    equal(url.searchParams.get(DESKTOP_QUERY) ?? undefined, options.token) ||
    equal(cookieValue(req), options.token) ||
    (!!internalHeader &&
      !!internalSecret &&
      equal(
        req.headers[internalHeader.toLowerCase()] as string | undefined,
        internalSecret
      ))
  );
}

/** Never forward the desktop capability to providers or include it in logs. */
export function stripDesktopCredentials(req: IncomingMessage): void {
  delete req.headers[DESKTOP_HEADER];
  if (req.headers.cookie) {
    const rest = req.headers.cookie
      .split(';')
      .filter((part) => !part.trim().startsWith(`${DESKTOP_COOKIE}=`))
      .join(';');
    if (rest.trim()) req.headers.cookie = rest;
    else delete req.headers.cookie;
  }
  // Preserve every other query byte (including signed URLs and repeated keys).
  if (req.url?.includes('?')) {
    const split = req.url.indexOf('?');
    const query = req.url
      .slice(split + 1)
      .split('&')
      .filter((item) => {
        try {
          return decodeURIComponent(item.split('=')[0]) !== DESKTOP_QUERY;
        } catch {
          return true;
        }
      })
      .join('&');
    req.url = req.url.slice(0, split) + (query ? `?${query}` : '');
  }
}

/**
 * Routes that answer with data or with bytes from addons, providers and
 * indexers rather than with the app's own pages. A browser that opens one as a
 * document gets an opaque, scriptless origin: provider HTML can never run as the
 * private app origin, use its session cookie, or reach the native bridge.
 */
const UNTRUSTED_CONTENT = [
  '/api/',
  '/builtins/',
  '/webdav',
  '/blocklist',
  '/chilllink/',
  '/seanime/',
  '/jellyfin/',
  '/stremio/',
];

export function sandboxedPath(path: string): boolean {
  if (!UNTRUSTED_CONTENT.some((prefix) => path.startsWith(prefix)))
    return false;
  // The configuration pages and the hosted web client are the app's own UI.
  if (/\/configure\/?$/.test(path)) return false;
  if (/^\/jellyfin\/(?:.*\/)?web(?:\/|$)/.test(path)) return false;
  return true;
}

export function desktopBoundary(
  options: DesktopOptions | undefined,
  internalHeader: string,
  internalSecret: string,
  establishSession?: (req: Request, res: Response) => void
): RequestHandler {
  return (req, res, next) => {
    if (!options) return next();
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!desktopAuthorised(req, options, internalHeader, internalSecret)) {
      res
        .status(403)
        .json({ success: false, detail: 'Private desktop backend' });
      return;
    }
    const bootstrap = req.path === '/__desktop/session';
    // Native players do not share the WebView cookie jar. Carry the capability
    // only over local redirects (error clips and local playback hops), never an
    // external Location header. Browser requests already carry their cookie.
    const queryAuthenticated =
      !bootstrap &&
      new URL(req.url, options.origin).searchParams.has(DESKTOP_QUERY);
    const sandboxed = sandboxedPath(req.path);
    if (queryAuthenticated || sandboxed) {
      const setHeader = res.setHeader.bind(res);
      res.setHeader = (name, value) => {
        const lower = name.toLowerCase();
        // Relayed provider headers must not lift the sandbox set below.
        if (
          sandboxed &&
          (lower === 'content-security-policy' ||
            lower === 'x-content-type-options')
        )
          return res;
        if (
          queryAuthenticated &&
          lower === 'location' &&
          typeof value === 'string'
        ) {
          try {
            const destination = new URL(value, options.origin);
            if (destination.origin === options.origin) {
              destination.searchParams.set(DESKTOP_QUERY, options.token);
              value = destination.toString();
            }
          } catch {
            /* Upstream handles invalid locations. */
          }
        }
        return setHeader(name, value);
      };
      if (sandboxed) setHeader('Content-Security-Policy', 'sandbox');
    }
    stripDesktopCredentials(req);
    req.originalUrl = req.url;

    if (bootstrap) {
      if (req.method !== 'GET' && req.method !== 'POST') {
        res.status(405).end();
        return;
      }
      establishSession?.(req, res);
      res.cookie(DESKTOP_COOKIE, options.token, {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        secure: false,
      });
      res.redirect(303, '/__desktop/client/');
      return;
    }
    next();
  };
}

/** Upgrade requests bypass Express. Preserve upstream websocket handlers behind the gate. */
export function secureDesktopUpgrades(
  server: Server,
  options?: DesktopOptions
): void {
  if (!options) return;
  const handlers = server.listeners('upgrade');
  server.removeAllListeners('upgrade');
  server.on('upgrade', (req, socket, head) => {
    if (!desktopAuthorised(req, options)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    stripDesktopCredentials(req);
    for (const handler of handlers) handler.call(server, req, socket, head);
  });
}


/** The shell waits for this exact line on stdout before its health check. */
export function announceDesktopReady(
  options: DesktopOptions | undefined,
  port: number
): void {
  if (!options) return;
  process.stdout.write(
    JSON.stringify({
      event: 'aiostreams-desktop-ready',
      port,
      url: options.origin,
    }) + '\n'
  );
}

/**
 * The shell asks for shutdown over stdin; EOF also means the shell crashed or
 * was force-closed. `stop` runs once; a stuck shutdown exits after ten seconds.
 */
export function watchDesktopStdin(
  options: DesktopOptions | undefined,
  stop: () => Promise<void>
): void {
  if (!options || process.env.AIOSTREAMS_DESKTOP_STDIN_CONTROL !== '1') return;
  let stopping = false;
  const requestStop = () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(1), 10_000).unref();
    void stop().finally(() => process.exit(0));
  };
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    input += chunk;
    if (input.length > 4096) return requestStop();
    let newline: number;
    while ((newline = input.indexOf('\n')) !== -1) {
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      try {
        if (JSON.parse(line)?.command === 'shutdown') requestStop();
      } catch {
        /* Unknown parent commands have no effect. */
      }
    }
  });
  process.stdin.on('end', requestStop);
  process.stdin.on('error', requestStop);
  process.stdin.resume();
}
