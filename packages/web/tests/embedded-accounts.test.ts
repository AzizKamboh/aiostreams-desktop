import { describe, expect, it } from 'vitest';
import {
  canStreamUsenet,
  parseEnvironment,
  passwordProblem,
  usernameProblem,
} from '../src/lib/embedded-accounts';

describe('AIOStreams account rules (upstream env.ts)', () => {
  it('accepts what upstream accepts', () => {
    expect(usernameProblem('aziz')).toBeNull();
    expect(passwordProblem('p:a=s|s word', 8)).toBeNull();
  });

  it('rejects what upstream would misparse', () => {
    for (const bad of ['', ' aziz', 'a:b', 'a,b', 'a=b', 'desktop', 'a\nb'])
      expect(usernameProblem(bad)).not.toBeNull();
    for (const bad of ['', 'has,comma', ' padded', 'tab\there'])
      expect(passwordProblem(bad)).not.toBeNull();
    expect(passwordProblem('short', 8)).not.toBeNull();
  });
});

describe('parseEnvironment', () => {
  it('reads Docker .env lines, quotes and all', () => {
    const result = parseEnvironment(
      'AIOSTREAMS_AUTH="aziz:pa:ss, guest:pw"',
      "AIOSTREAMS_AUTH_PERMISSIONS='guest=service|proxy'"
    );
    expect(result).toEqual({
      ok: true,
      accounts: [
        { username: 'aziz', password: 'pa:ss', permissions: ['admin'] },
        { username: 'guest', password: 'pw', permissions: ['service', 'proxy'] },
      ],
    });
  });

  it('supports none and reports upstream errors', () => {
    const none = parseEnvironment('a:b', 'a=none');
    expect(none.ok && none.accounts[0].permissions).toEqual([]);
    expect(parseEnvironment('', '').ok).toBe(false);
    expect(parseEnvironment('nopassword', '').ok).toBe(false);
    expect(parseEnvironment('a:b,a:c', '').ok).toBe(false);
    expect(parseEnvironment('a:b', 'a=superuser').ok).toBe(false);
    expect(parseEnvironment('a:b', 'a=none|admin').ok).toBe(false);
    expect(parseEnvironment('a:b', 'ghost=admin').ok).toBe(false);
    expect(parseEnvironment('desktop:x', '').ok).toBe(false);
  });

  it('knows which permissions stream Usenet', () => {
    expect(canStreamUsenet(['admin'])).toBe(true);
    expect(canStreamUsenet(['service'])).toBe(true);
    expect(canStreamUsenet(['proxy'])).toBe(false);
  });
});
