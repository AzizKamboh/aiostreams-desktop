/**
 * AIOStreams Integrated: the user's AIOStreams accounts, in exactly the shape a
 * Docker install gives AIOSTREAMS_AUTH and AIOSTREAMS_AUTH_PERMISSIONS. Rules
 * mirror upstream's parsers in packages/core/src/utils/env.ts; the native shell
 * checks them again before saving, so a saved account cannot stop the server.
 */

/** Upstream's permission names (packages/core/src/utils/permissions.ts). */
export const PERMISSIONS = [
  'admin',
  'proxy',
  'service',
  'sabnzbd',
  'webdav',
  'createConfig',
] as const;
export type AccountPermission = (typeof PERMISSIONS)[number];

/** Reserved for the app's own dashboard session. */
export const RESERVED_USER = 'desktop';
/** Required for accounts created in the simple form. */
export const MIN_PASSWORD = 8;

export interface AccountInput {
  username: string;
  /** Empty with `keep` keeps the saved password. */
  password: string;
  permissions: AccountPermission[];
  keep?: boolean;
}

const CONTROL = /[\u0000-\u001f\u007f]/;

/** An English reason, or null when upstream would accept the username. */
export function usernameProblem(username: string): string | null {
  if (!username) return 'Enter a username.';
  if (username.trim() !== username)
    return 'Usernames cannot start or end with a space.';
  if (username.length > 128 || CONTROL.test(username))
    return 'The username is too long or has invalid characters.';
  const bad = [':', ',', '='].find((c) => username.includes(c));
  if (bad) return `Usernames cannot contain "${bad}".`;
  if (username === RESERVED_USER)
    return 'The username "desktop" is reserved by the app.';
  return null;
}

export function passwordProblem(password: string, minimum = 1): string | null {
  if (!password) return 'Enter a password.';
  if (password.length < minimum)
    return `Use at least ${minimum} characters.`;
  if (password.trim() !== password)
    return 'Passwords cannot start or end with a space.';
  if (password.length > 256 || CONTROL.test(password))
    return 'The password is too long or has invalid characters.';
  if (password.includes(',')) return 'Passwords cannot contain a comma.';
  return null;
}

/** Accepts a bare value or a whole `NAME=value` line, optionally quoted. */
function envValue(raw: string, name: string): string {
  let value = raw.trim();
  const prefix = `${name}=`;
  if (value.startsWith(prefix)) value = value.slice(prefix.length).trim();
  if (
    value.length >= 2 &&
    (value[0] === '"' || value[0] === "'") &&
    value.at(-1) === value[0]
  )
    value = value.slice(1, -1);
  return value;
}

export type ParseResult =
  | { ok: true; accounts: AccountInput[] }
  | { ok: false; error: string };

/**
 * Parse the two variables as upstream does. Users without a permissions entry
 * get upstream's default, admin. Duplicate usernames, which upstream silently
 * collapses to the last one, are reported instead.
 */
export function parseEnvironment(
  authRaw: string,
  permissionsRaw: string
): ParseResult {
  const auth = envValue(authRaw, 'AIOSTREAMS_AUTH');
  const accounts: AccountInput[] = [];
  for (const piece of auth.split(',')) {
    const entry = piece.trim();
    if (!entry) continue;
    const sep = entry.indexOf(':');
    const username = sep === -1 ? '' : entry.slice(0, sep).trim();
    const password = sep === -1 ? '' : entry.slice(sep + 1).trim();
    if (!username || !password)
      return {
        ok: false,
        error:
          'AIOSTREAMS_AUTH must be a comma-separated list of username:password pairs.',
      };
    if (accounts.some((a) => a.username === username))
      return { ok: false, error: `"${username}" appears twice.` };
    const problem = usernameProblem(username) ?? passwordProblem(password);
    if (problem) return { ok: false, error: `${username}: ${problem}` };
    accounts.push({ username, password, permissions: ['admin'] });
  }
  if (accounts.length === 0)
    return { ok: false, error: 'AIOSTREAMS_AUTH has no accounts.' };

  const permissions = envValue(permissionsRaw, 'AIOSTREAMS_AUTH_PERMISSIONS');
  for (const piece of permissions.split(',')) {
    const entry = piece.trim();
    if (!entry) continue;
    const eq = entry.indexOf('=');
    const username = eq === -1 ? '' : entry.slice(0, eq).trim();
    if (!username)
      return {
        ok: false,
        error: `Invalid permission entry "${entry}". Expected username=perm1|perm2.`,
      };
    const account = accounts.find((a) => a.username === username);
    if (!account)
      return {
        ok: false,
        error: `"${username}" has permissions but is not in AIOSTREAMS_AUTH.`,
      };
    const list = entry
      .slice(eq + 1)
      .split('|')
      .map((p) => p.trim())
      .filter(Boolean);
    if (list.length === 0 || (list.length === 1 && list[0] === 'none')) {
      account.permissions = [];
      continue;
    }
    if (list.includes('none'))
      return {
        ok: false,
        error: `"none" for ${username} cannot be combined with other permissions.`,
      };
    const unknown = list.find(
      (p) => !(PERMISSIONS as readonly string[]).includes(p)
    );
    if (unknown)
      return {
        ok: false,
        error: `Unknown permission "${unknown}". Valid: ${PERMISSIONS.join(', ')}, none.`,
      };
    account.permissions = [...new Set(list)] as AccountPermission[];
  }
  return { ok: true, accounts };
}

/** Whether these permissions pass the built-in Usenet service's check. */
export function canStreamUsenet(permissions: readonly string[]): boolean {
  return permissions.includes('admin') || permissions.includes('service');
}
