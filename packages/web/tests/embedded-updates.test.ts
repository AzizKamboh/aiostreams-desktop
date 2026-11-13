import { describe, expect, it } from 'vitest';
import { canRetry, parseUpdate, pollInterval } from '../src/lib/embedded-update-state';

describe('integrated update state from the shell', () => {
  it('accepts the shell state and clamps progress', () => {
    const update = parseUpdate({ type: 'integrated-update-state', state: 'downloading', progress: 140, latestVersion: '0.3.0' });
    expect(update?.state).toBe('downloading');
    expect(update?.progress).toBe(100);
  });

  it('drops other messages and unknown states', () => {
    expect(parseUpdate({ type: 'update-state', state: 'ready' })).toBeNull();
    expect(parseUpdate({ type: 'integrated-update-state', state: 'installing-now' })).toBeNull();
    expect(parseUpdate(null)).toBeNull();
    expect(parseUpdate('integrated-update-state')).toBeNull();
  });

  it('links only to GitHub release pages', () => {
    const ok = 'https://github.com/AzizKamboh/aiostreams-desktop/releases/tag/v0.3.0';
    expect(parseUpdate({ type: 'integrated-update-state', state: 'ready', releaseNotesUrl: ok })?.releaseNotesUrl).toBe(ok);
    for (const bad of ['javascript:alert(1)', 'https://evil.example/releases/tag/v1', 'https://github.com/a/b/releases/tag/v1"><script>'])
      expect(parseUpdate({ type: 'integrated-update-state', state: 'ready', releaseNotesUrl: bad })?.releaseNotesUrl).toBeNull();
  });

  it('polls quickly only while something moves', () => {
    expect(pollInterval(parseUpdate({ type: 'integrated-update-state', state: 'downloading' }))).toBe(1000);
    expect(pollInterval(parseUpdate({ type: 'integrated-update-state', state: 'current' }))).toBe(30000);
    expect(pollInterval(null)).toBe(30000);
  });

  it('offers Retry after a failure', () => {
    expect(canRetry(parseUpdate({ type: 'integrated-update-state', state: 'error', lastError: 'offline' }))).toBe(true);
    expect(canRetry(parseUpdate({ type: 'integrated-update-state', state: 'current' }))).toBe(false);
  });
});
