import { appBridge } from './hosts/shell/bridge';

const ORIGIN_KEY = 'aiostreams-desktop-last-origin';
const owns = (key: string) =>
  key.startsWith('aiostreams') ||
  key === 'jellyfin_credentials' ||
  key === 'theme';

/** Restore before mounting the client: a replacement port has a new browser origin. */
export function hydrateEmbeddedStorage(
  values: Record<string, string>,
  origin: string | null
): void {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, i) =>
      localStorage.key(i)
    );
    for (const key of keys) if (key && owns(key)) localStorage.removeItem(key);
    for (const [key, value] of Object.entries(values)) {
      if (owns(key) && typeof value === 'string')
        localStorage.setItem(key, value);
    }
    const oldOrigin = localStorage.getItem(ORIGIN_KEY);
    if (oldOrigin && origin && oldOrigin !== origin)
      migrateLocalAddress(oldOrigin, origin);
    if (origin) localStorage.setItem(ORIGIN_KEY, origin);
  } catch {
    // Blocked storage still permits the client to run for this session.
  }
}

/** Only the previous embedded server moves; unrelated remote-server credentials stay put. */
function migrateLocalAddress(previous: string, current: string): void {
  const oldBase = `${previous}/jellyfin`;
  const newBase = `${current}/jellyfin`;
  const rebase = (value: unknown): unknown =>
    typeof value === 'string' &&
    (value === oldBase || value.startsWith(`${oldBase}/`))
      ? newBase + value.slice(oldBase.length)
      : value;
  const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  const json = (key: string, transform: (value: unknown) => unknown) => {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    try {
      localStorage.setItem(key, JSON.stringify(transform(JSON.parse(raw))));
    } catch {
      /* Skip damaged entries. */
    }
  };
  json('jellyfin_credentials', (value) =>
    record(value) && Array.isArray(value.Servers)
      ? {
          ...value,
          Servers: value.Servers.map((server: unknown) =>
            record(server)
              ? { ...server, ManualAddress: rebase(server.ManualAddress) }
              : server
          ),
        }
      : value
  );
  json('aiostreams-web-servers', (value) =>
    Array.isArray(value)
      ? value.map((server: unknown) =>
          record(server) ? { ...server, base: rebase(server.base) } : server
        )
      : value
  );
  json('aiostreams-web-server', rebase);
  for (const prefix of [
    'aiostreams-web-last-user:',
    'aiostreams-web-left-user:',
    'aiostreams-web-signed-out:',
    'aiostreams-web-saved-user:',
  ]) {
    const keys = Array.from({ length: localStorage.length }, (_, i) =>
      localStorage.key(i)
    );
    for (const key of keys) {
      if (!key?.startsWith(prefix)) continue;
      const before = key.slice(prefix.length);
      const after = rebase(before);
      const value = localStorage.getItem(key);
      if (after !== before && typeof after === 'string' && value !== null) {
        localStorage.setItem(prefix + after, value);
        localStorage.removeItem(key);
      }
    }
  }
}

/** Snapshot only app data, including dashboard changes made in the same-origin iframe. */
export function persistEmbeddedStorage(): () => void {
  let last = '';
  const flush = () => {
    try {
      const values: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && owns(key)) values[key] = localStorage.getItem(key)!;
      }
      const serialized = JSON.stringify(values);
      if (serialized === last) return;
      last = serialized;
      appBridge()?.send({ type: 'backend-storage', values });
    } catch {
      /* Private browsing may deny access to storage. */
    }
  };
  const changed = () => flush();
  const timer = setInterval(flush, 1000);
  window.addEventListener('storage', changed);
  window.addEventListener('aiostreams-storage', changed);
  window.addEventListener('pagehide', changed);
  flush();
  return () => {
    flush();
    clearInterval(timer);
    window.removeEventListener('storage', changed);
    window.removeEventListener('aiostreams-storage', changed);
    window.removeEventListener('pagehide', changed);
  };
}
