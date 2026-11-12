/**
 * AIOStreams Integrated: environment defaults for the private desktop backend.
 *
 * Imported by `env.ts` before it reads the environment. Does nothing unless the
 * desktop shell started this process (it sets AIOSTREAMS_DESKTOP_TOKEN). Kept in
 * its own file so upstream changes to `env.ts` rarely conflict with it.
 *
 * Accounts the user created in the desktop setup screen arrive in the ordinary
 * AIOSTREAMS_AUTH / AIOSTREAMS_AUTH_PERMISSIONS variables, exactly as a Docker
 * install would set them, and upstream validates and applies them unchanged.
 * This file only appends the internal `desktop` account the shell uses for its
 * own dashboard session; it never replaces the user's accounts.
 */
import { createHmac } from 'crypto';

/** Reserved for the shell's dashboard session; the setup screen refuses it. */
export const DESKTOP_INTERNAL_USER = 'desktop';

if (process.env.AIOSTREAMS_DESKTOP_TOKEN) {
  // Derived from the stable server key, so links generated with it survive restarts.
  const internalPassword = createHmac('sha256', process.env.SECRET_KEY || '')
    .update('aiostreams-desktop-admin-v1')
    .digest('hex');
  const internal = `${DESKTOP_INTERNAL_USER}:${internalPassword}`;
  const userAuth = process.env.AIOSTREAMS_AUTH?.trim();
  process.env.AIOSTREAMS_AUTH = userAuth ? `${userAuth},${internal}` : internal;
  const permissions = process.env.AIOSTREAMS_AUTH_PERMISSIONS?.trim() || '';
  process.env.AIOSTREAMS_AUTH_PERMISSIONS = [
    permissions,
    `${DESKTOP_INTERNAL_USER}=admin`,
  ]
    .filter(Boolean)
    .join(',');
  process.env.ANALYTICS_ENABLED ??= 'false';
  // Tracker addons may advertise watch_state without the user opting into
  // scrobbling. Embedded installs keep viewing events local until enabled.
  process.env.WATCH_STATE_REPORT_ENABLED ??= 'false';
  process.env.APP_REPORTS_FORWARD_TO ??= '';
  process.env.COMMUNITY_REMOTE_SOURCES ??= '[]';
  process.env.LOG_SENSITIVE_INFO = 'false';
  process.env.SYSTEM_LIFECYCLE_ENABLED = 'false';
}

export function isDesktopBackend(): boolean {
  return !!process.env.AIOSTREAMS_DESKTOP_TOKEN;
}

let desktopSecrets: string[] | undefined;

/**
 * Remove the desktop capability, the server key and every AIOSTREAMS_AUTH
 * password from a log line. Applied even when sensitive logging is enabled.
 */
export function redactDesktopSecrets(s: string): string {
  if (!isDesktopBackend()) return s;
  desktopSecrets ??= [
    process.env.AIOSTREAMS_DESKTOP_TOKEN,
    process.env.SECRET_KEY,
    ...(process.env.AIOSTREAMS_AUTH ?? '').split(',').map((entry) => {
      const sep = entry.indexOf(':');
      return sep === -1 ? '' : entry.slice(sep + 1).trim();
    }),
  ]
    // Very short values would censor ordinary words; the setup screen
    // requires at least eight characters for new passwords.
    .filter((v): v is string => !!v && v.length >= 6)
    .sort((a, b) => b.length - a.length);
  for (const secret of desktopSecrets) s = s.split(secret).join('<redacted>');
  return s;
}
