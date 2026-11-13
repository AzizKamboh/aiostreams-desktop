import { describe, it, expect } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import {
  desktopOptions,
  desktopAuthorised,
  desktopBoundary,
  sandboxedPath,
  stripDesktopCredentials,
  DESKTOP_COOKIE,
} from './desktop.js';

const token = 'f'.repeat(64);
const options = desktopOptions({
  AIOSTREAMS_DESKTOP_TOKEN: token,
  PORT: '24680',
  BASE_URL: 'http://127.0.0.1:24680',
  INTERNAL_URL: 'http://127.0.0.1:24680',
})!;
function request(headers: Record<string, string> = {}, url = '/api/v1/health') {
  return {
    headers: { host: options.host, ...headers },
    url,
  } as IncomingMessage;
}

describe('private desktop boundary', () => {
  it('leaves hosted mode disabled and rejects incomplete desktop bootstrap', () => {
    expect(desktopOptions({})).toBeUndefined();
    expect(() =>
      desktopOptions({ AIOSTREAMS_DESKTOP_TOKEN: 'weak' })
    ).toThrow();
    expect(() =>
      desktopOptions({
        AIOSTREAMS_DESKTOP_TOKEN: token,
        PORT: '24680',
        BASE_URL: 'http://0.0.0.0:24680',
      })
    ).toThrow();
  });
  it('requires a capability; rejects DNS rebinding and cross-site browser requests', () => {
    expect(desktopAuthorised(request(), options)).toBe(false);
    expect(
      desktopAuthorised(
        request({ 'x-aiostreams-desktop-token': token }),
        options
      )
    ).toBe(true);
    expect(
      desktopAuthorised(
        request({
          host: 'evil.example:24680',
          'x-aiostreams-desktop-token': token,
        }),
        options
      )
    ).toBe(false);
    expect(
      desktopAuthorised(
        request({
          origin: 'https://evil.example',
          'x-aiostreams-desktop-token': token,
        }),
        options
      )
    ).toBe(false);
    expect(
      desktopAuthorised(
        request({
          origin: options.origin,
          cookie: `${DESKTOP_COOKIE}=${token}`,
        }),
        options
      )
    ).toBe(true);
  });
  it('accepts owned internal calls and per-request media capabilities', () => {
    expect(
      desktopAuthorised(request({}, `/video?__desktop_token=${token}`), options)
    ).toBe(true);
    expect(
      desktopAuthorised(
        request({ 'x-internal': 'internal-secret' }),
        options,
        'x-internal',
        'internal-secret'
      )
    ).toBe(true);
    expect(
      desktopAuthorised(
        request({ 'x-internal': 'wrong' }),
        options,
        'x-internal',
        'internal-secret'
      )
    ).toBe(false);
  });
  it('strips desktop credentials before any logger or upstream proxy; keeps signed query bytes intact', () => {
    const req = request(
      {
        'x-aiostreams-desktop-token': token,
        cookie: `${DESKTOP_COOKIE}=${token}; session=keep`,
      },
      `/stream?signed=a%2Fb+%3D&__desktop_token=${token}&signed=second`
    );
    stripDesktopCredentials(req);
    expect(req.headers['x-aiostreams-desktop-token']).toBeUndefined();
    expect(req.headers.cookie?.trim()).toBe('session=keep');
    expect(req.url).toBe('/stream?signed=a%2Fb+%3D&signed=second');
    const only = request(
      { cookie: `${DESKTOP_COOKIE}=${token}` },
      `/?__desktop_token=${token}`
    );
    stripDesktopCredentials(only);
    expect(only.headers.cookie).toBeUndefined();
    expect(only.url).toBe('/');
  });
});

describe('desktop HTTP redirects', () => {
  it('authenticates the configuration bootstrap and carries media tokens only across exact-origin redirects', async () => {
    const app = express();
    const server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address() as { port: number };
    const origin = `http://127.0.0.1:${address.port}`;
    const local = { token, origin, host: `127.0.0.1:${address.port}` };
    app.use(
      desktopBoundary(local, 'x-internal', 'internal-secret', (_req, res) => {
        res.cookie('test-upstream-session', 'admin', { httpOnly: true });
      })
    );
    app.get('/echo', (req, res) =>
      res.json({ url: req.originalUrl, headers: req.headers })
    );
    app.get('/local', (_req, res) => res.redirect('/echo?other=1'));
    app.get('/external', (_req, res) =>
      res.redirect('https://provider.test/stream')
    );
    // A hostname prefix is not an origin, including a port-prefix trick.
    app.get('/prefix', (_req, res) =>
      res.redirect(`http://127.0.0.1:${address.port === 1 ? 11 : 1}/stream`)
    );
    try {
      expect((await fetch(`${origin}/echo`)).status).toBe(403);
      const bootstrap = await fetch(
        `${origin}/__desktop/session?__desktop_token=${token}`,
        { redirect: 'manual' }
      );
      expect(bootstrap.status).toBe(303);
      expect(bootstrap.headers.get('location')).toBe('/__desktop/client/');
      expect(
        bootstrap.headers
          .getSetCookie()
          .some((s) => s.includes('HttpOnly') && s.includes('SameSite=Strict'))
      ).toBe(true);
      expect(
        bootstrap.headers
          .getSetCookie()
          .some((s) => s.startsWith('test-upstream-session='))
      ).toBe(true);
      const redirect = await fetch(`${origin}/local?__desktop_token=${token}`, {
        redirect: 'manual',
      });
      const target = new URL(redirect.headers.get('location')!);
      expect(target.origin).toBe(origin);
      expect(target.searchParams.get('__desktop_token')).toBe(token);
      const response = await fetch(target);
      const echoed = (await response.json()) as {
        url: string;
        headers: Record<string, unknown>;
      };
      expect(response.status).toBe(200);
      expect(echoed.url).toBe('/echo?other=1');
      expect(JSON.stringify(echoed)).not.toContain(token);
      for (const route of ['/external', '/prefix']) {
        const out = await fetch(`${origin}${route}?__desktop_token=${token}`, {
          redirect: 'manual',
        });
        expect(out.status).toBe(302);
        expect(out.headers.get('location')).not.toContain(token);
        expect(out.headers.get('location')).not.toContain('__desktop_token');
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    }
  });
});

describe('sandboxedPath', () => {
  it('sandboxes routes that relay addon, provider and indexer content', () => {
    for (const path of [
      '/api/v1/proxy/abc',
      '/builtins/x',
      '/webdav/file.mkv',
      '/jellyfin/Videos/1/stream',
      '/stremio/u/p/stream/movie/x.json',
      // Look-alikes of the exempt pages stay sandboxed.
      '/api/v1/proxy/abc/configure',
      '/stremio/u/p/stream/configure',
      '/jellyfin/u/p/Videos/1/web/evil.html',
      '/jellyfin/web/index.html',
    ])
      expect(sandboxedPath(path)).toBe(true);
  });
  it('leaves the app and configuration pages alone', () => {
    for (const path of [
      '/__desktop/client/',
      '/dashboard/usenet/providers',
      '/stremio/configure',
      '/stremio/u/p/configure',
      '/jellyfin/u/p/web/index.html',
      '/jellyfin/p/code/web',
      '/',
    ])
      expect(sandboxedPath(path)).toBe(false);
  });
});
