/**
 * AIOStreams Integrated: what the embedded shell shares with upstream screens.
 *
 * The shell (components/shell/embedded-desktop.tsx) publishes its state and
 * actions here; the small hooks in the account menu, Settings, and the player
 * read them. Outside the integrated desktop app nothing is published, every
 * hook sees null, and upstream screens render exactly as before.
 */
import React from 'react';
import type { PlayerController } from './playback/controller';
import type { ShellAnswer } from './hosts/shell/bridge';

export type BackendState = ShellAnswer<'backend-state'>;
export type BackendMode = 'local' | 'remote';

export interface DesktopShell {
  state: BackendState;
  mode: BackendMode;
  /** The local server is running and this window uses it. */
  local: boolean;
  /** Server dashboard or configuration, over the client; pauses playback. */
  openServer(path?: string): void;
  restart(): void;
  chooseMode(mode: BackendMode): void;
  manageAccounts(): void;
  readDiagnostics(): Promise<string>;
  origin: string | null;
}

export const DASHBOARD_PATH = '/dashboard';
export const CONFIGURE_PATH = '/stremio/configure';
export const USENET_PROVIDERS_PATH = '/dashboard/usenet/providers';

let shell: DesktopShell | null = null;
const listeners = new Set<() => void>();

export function publishDesktopShell(next: DesktopShell | null): void {
  shell = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Null outside the integrated desktop app. */
export function useDesktopShell(): DesktopShell | null {
  return React.useSyncExternalStore(subscribe, () => shell);
}

// The player that is up, from the hook every player screen already runs
// (useRemotePlayer). Its real state and setPaused drive pause/resume.
let activePlayer: PlayerController | null = null;

export function useRegisterActivePlayer(player: PlayerController): void {
  React.useEffect(() => {
    activePlayer = player;
    return () => {
      if (activePlayer === player) activePlayer = null;
    };
  }, [player]);
}

export function activeDesktopPlayer(): PlayerController | null {
  return activePlayer;
}

/** Keyboard shortcuts, documented in README-INTEGRATED.md. */
export function desktopShortcut(event: KeyboardEvent): string | null {
  if (event.altKey || event.metaKey || !event.ctrlKey) return null;
  if (event.code !== 'Comma') return null;
  return event.shiftKey ? CONFIGURE_PATH : DASHBOARD_PATH;
}

/** Typing in a field never triggers a shortcut. */
export function typingIn(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.closest !== 'function') return false;
  return !!element.closest(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"]'
  );
}
