/**
 * AIOStreams Integrated: the integrated updater's state as the shell sends it,
 * validated. No imports, so tests need no app environment.
 */
export type IntegratedUpdateState =
  | 'off'
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'ready'
  | 'current'
  | 'error';

export interface IntegratedUpdate {
  type: 'integrated-update-state';
  state: IntegratedUpdateState;
  offReason?: string | null;
  channel?: 'stable' | 'preview' | null;
  installedChannel?: 'stable' | 'preview' | null;
  installedVersion?: string | null;
  integratedVersion?: string;
  portable?: boolean;
  feed?: string | null;
  latestVersion?: string | null;
  readyVersion?: string | null;
  progress?: number | null;
  releaseNotesUrl?: string | null;
  /** Unix seconds. */
  lastCheck?: number | null;
  lastSuccess?: number | null;
  nextCheck?: number | null;
  lastError?: string | null;
  failures?: number;
  /** Feed checks since the app started. */
  checks?: number;
  playing?: boolean;
  installOnExit?: boolean;
  /** Set when an install request was not carried out. */
  refused?: 'playing' | 'nothing-ready';
}

const STATES: readonly string[] = ['off', 'idle', 'checking', 'downloading', 'ready', 'current', 'error'];
const RELEASES = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/releases\/tag\/v[0-9A-Za-z.+-]+$/;

/** Accepts only a well-formed state from the shell; anything else is dropped. */
export function parseUpdate(message: unknown): IntegratedUpdate | null {
  if (!message || typeof message !== 'object') return null;
  const m = message as Record<string, unknown>;
  if (m.type !== 'integrated-update-state' || typeof m.state !== 'string' || !STATES.includes(m.state)) return null;
  const update = { ...m } as unknown as IntegratedUpdate;
  // Only release pages of a GitHub repository are linked.
  if (update.releaseNotesUrl && !RELEASES.test(update.releaseNotesUrl)) update.releaseNotesUrl = null;
  if (typeof update.progress === 'number') update.progress = Math.max(0, Math.min(100, update.progress));
  return update;
}

/** How often the page asks: often while something moves, rarely otherwise. */
export function pollInterval(update: IntegratedUpdate | null): number {
  return update?.state === 'checking' || update?.state === 'downloading' ? 1000 : 30000;
}

/** Whether the "Retry" action applies. */
export const canRetry = (update: IntegratedUpdate | null) =>
  update?.state === 'error' && !!update.lastError;
