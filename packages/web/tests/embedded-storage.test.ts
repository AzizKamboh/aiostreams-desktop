import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/hosts/shell/bridge', () => ({
  appBridge: () => ({ send }),
}));
import {
  hydrateEmbeddedStorage,
  persistEmbeddedStorage,
} from '../src/lib/embedded-storage';

class MemoryStorage {
  values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, String(value));
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

let local: MemoryStorage;
beforeEach(() => {
  vi.useFakeTimers();
  send.mockClear();
  local = new MemoryStorage();
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('embedded client storage', () => {
  it('restores dashboard drafts and credentials before mounting on a new origin', () => {
    local.setItem('aiostreams-old-deleted-setting', 'stale');
    local.setItem('unrelated-key', 'preserve');
    const values = {
      'aiostreams-config-draft': JSON.stringify({
        provider: 'saved-token',
        name: '日本語 / My profile',
      }),
      jellyfin_credentials: JSON.stringify({
        Servers: [{ AccessToken: 'saved-login' }],
      }),
      'aiostreams-desktop-backend-mode': JSON.stringify('remote'),
      'not-an-app-key': 'ignore',
    };
    hydrateEmbeddedStorage(values, 'http://127.0.0.1:43210');
    expect(local.getItem('aiostreams-config-draft')).toBe(
      values['aiostreams-config-draft']
    );
    expect(local.getItem('jellyfin_credentials')).toBe(
      values.jellyfin_credentials
    );
    expect(local.getItem('aiostreams-desktop-backend-mode')).toBe('"remote"');
    expect(local.getItem('aiostreams-old-deleted-setting')).toBeNull();
    expect(local.getItem('unrelated-key')).toBe('preserve');
    expect(local.getItem('not-an-app-key')).toBeNull();
  });

  it('moves embedded root and named-config sign-ins across a port conflict without touching remote sign-ins', () => {
    const old = 'http://127.0.0.1:3000';
    const next = 'http://127.0.0.1:43123';
    const remote = 'https://example.test/jellyfin';
    const named = '/jellyfin/u/example';
    const values = {
      'aiostreams-desktop-last-origin': old,
      jellyfin_credentials: JSON.stringify({
        Servers: [
          { ManualAddress: old + '/jellyfin', AccessToken: 'local' },
          { ManualAddress: old + named, AccessToken: 'named' },
          { ManualAddress: remote, AccessToken: 'remote' },
        ],
      }),
      'aiostreams-web-servers': JSON.stringify([
        { base: old + named },
        { base: remote },
      ]),
      'aiostreams-web-server': JSON.stringify(old + named),
      ['aiostreams-web-last-user:' + old + named]: '"local-user"',
      ['aiostreams-web-last-user:' + remote]: '"remote-user"',
    };
    hydrateEmbeddedStorage(values, next);
    const stored = JSON.parse(local.getItem('jellyfin_credentials')!);
    expect(stored.Servers).toEqual([
      { ManualAddress: next + '/jellyfin', AccessToken: 'local' },
      { ManualAddress: next + named, AccessToken: 'named' },
      { ManualAddress: remote, AccessToken: 'remote' },
    ]);
    expect(local.getItem('aiostreams-web-server')).toBe(
      JSON.stringify(next + named)
    );
    expect(local.getItem('aiostreams-web-last-user:' + next + named)).toBe(
      '"local-user"'
    );
    expect(local.getItem('aiostreams-web-last-user:' + old + named)).toBeNull();
    expect(local.getItem('aiostreams-web-last-user:' + remote)).toBe(
      '"remote-user"'
    );
  });

  it('snapshots app changes and sign-out deletions, excluding unrelated origin data', () => {
    local.setItem('jellyfin_credentials', '{"token":"kept"}');
    local.setItem('aiostreams-config-draft', 'saved dashboard draft');
    local.setItem('unrelated', 'private other data');
    const stop = persistEmbeddedStorage();
    expect(send).toHaveBeenLastCalledWith({
      type: 'backend-storage',
      values: {
        jellyfin_credentials: '{"token":"kept"}',
        'aiostreams-config-draft': 'saved dashboard draft',
      },
    });
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledTimes(1);
    local.removeItem('jellyfin_credentials');
    window.dispatchEvent(new Event('aiostreams-storage'));
    expect(send).toHaveBeenLastCalledWith({
      type: 'backend-storage',
      values: {
        'aiostreams-config-draft': 'saved dashboard draft',
      },
    });
    local.setItem('aiostreams-config-draft', 'new iframe draft');
    window.dispatchEvent(new Event('storage'));
    expect(send).toHaveBeenLastCalledWith({
      type: 'backend-storage',
      values: {
        'aiostreams-config-draft': 'new iframe draft',
      },
    });
    stop();
    vi.advanceTimersByTime(2000);
    expect(send).toHaveBeenCalledTimes(3);
  });
});
