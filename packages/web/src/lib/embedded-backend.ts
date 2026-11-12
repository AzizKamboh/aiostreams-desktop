import { appBridge } from './hosts/shell/bridge';

const CONFIGURE_EVENT = 'aiostreams-embedded-configure';
let localOrigin: string | null = null;

/** Accept only a loopback address supplied by the native process manager. */
export function embeddedOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

export function setEmbeddedOrigin(origin: string | null): void {
  localOrigin = origin;
}

/** A local configuration stays in the app's settings pane. */
export function openConfiguration(url: string): void {
  if (appBridge()?.backend && localOrigin) {
    try {
      if (new URL(url).origin === localOrigin) {
        window.dispatchEvent(new CustomEvent(CONFIGURE_EVENT, { detail: url }));
        return;
      }
    } catch {
      /* The browser reports an invalid external address. */
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

export function onOpenConfiguration(
  listener: (url: string) => void
): () => void {
  const handle = (event: Event) => {
    const detail: unknown = (event as CustomEvent).detail;
    try {
      if (
        typeof detail === 'string' &&
        localOrigin &&
        new URL(detail).origin === localOrigin
      )
        listener(detail);
    } catch {
      /* Ignore malformed events from other page scripts. */
    }
  };
  window.addEventListener(CONFIGURE_EVENT, handle);
  return () => window.removeEventListener(CONFIGURE_EVENT, handle);
}
