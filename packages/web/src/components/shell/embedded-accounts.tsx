/**
 * AIOStreams Integrated: create and manage the AIOStreams accounts that a
 * Docker install sets with AIOSTREAMS_AUTH and AIOSTREAMS_AUTH_PERMISSIONS.
 * The native shell stores them with DPAPI, restarts the local server with them
 * and checks each against the built-in Usenet service before reporting ready.
 */
import React from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Button } from '@aiostreams/ui/button';
import { copyToClipboard } from '@aiostreams/ui/utils/clipboard';
import { appBridge, type EmbeddedAccount } from '@/lib/hosts/shell/bridge';
import {
  MIN_PASSWORD,
  PERMISSIONS,
  canStreamUsenet,
  parseEnvironment,
  passwordProblem,
  usernameProblem,
  type AccountInput,
  type AccountPermission,
} from '@/lib/embedded-accounts';

const field =
  'w-full rounded-lg border border-white/20 bg-[#18181d] px-3 py-2.5 text-white placeholder:text-gray-500 focus:border-white/50 focus:outline-none';
const panel =
  'fixed inset-0 z-[60] overflow-auto bg-[#101014] text-white';

function permissionLabel(permission: AccountPermission): string {
  switch (permission) {
    case 'admin':
      return t`Administrator (all permissions)`;
    case 'service':
      return t`Built-in Usenet streaming (service)`;
    case 'proxy':
      return t`Built-in proxy`;
    case 'sabnzbd':
      return t`SABnzbd API`;
    case 'webdav':
      return t`WebDAV`;
    case 'createConfig':
      return t`Create configurations`;
  }
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  autoComplete: string;
  placeholder?: string;
}) {
  const [shown, setShown] = React.useState(false);
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5 text-sm">
      <span className="text-gray-300">{label}</span>
      <span className="flex gap-2">
        <input
          id={id}
          type={shown ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          placeholder={placeholder}
          spellCheck={false}
          className={field}
        />
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-pressed={shown}
          aria-controls={id}
          className="shrink-0 rounded-lg border border-white/20 px-3 text-sm text-gray-300 hover:bg-white/5"
        >
          {shown ? t`Hide` : t`Show`}
        </button>
      </span>
    </label>
  );
}

/** Send the accounts to the native shell and wait for its answer. */
function saveAccounts(
  accounts: AccountInput[],
  replace: boolean
): Promise<string | null> {
  const bridge = appBridge();
  if (!bridge) return Promise.resolve(t`The desktop app is not available.`);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(t`The app did not answer. Open the logs and try again.`);
    }, 15_000);
    const unsubscribe = bridge.subscribe((message) => {
      if (message.type !== 'backend-accounts-result') return;
      clearTimeout(timer);
      unsubscribe();
      resolve(message.ok ? null : message.message || t`The accounts were not saved.`);
    });
    bridge.send({ type: 'backend-accounts-save', accounts, replace });
  });
}

interface Row {
  username: string;
  password: string;
  permissions: AccountPermission[];
  /** Saved before; an empty password keeps the saved one. */
  existing: boolean;
  removed: boolean;
}

/**
 * First run: create the first account. Later: change passwords, permissions,
 * add or remove accounts, or paste the Docker environment variables.
 */
export function AccountSetup({
  accounts,
  onSkip,
  onCancel,
  onUseRemote,
}: {
  accounts: EmbeddedAccount[];
  /** First run only: continue without an account. */
  onSkip?(): void;
  /** Management only: close without changes. */
  onCancel?(): void;
  onUseRemote?(): void;
}) {
  const managing = accounts.length > 0;
  const [advanced, setAdvanced] = React.useState(false);
  const [rows, setRows] = React.useState<Row[]>(() =>
    managing
      ? accounts.map((a) => ({
          username: a.username,
          password: '',
          permissions: a.permissions.filter((p): p is AccountPermission =>
            (PERMISSIONS as readonly string[]).includes(p)
          ),
          existing: true,
          removed: false,
        }))
      : [
          {
            username: '',
            password: '',
            permissions: ['admin'],
            existing: false,
            removed: false,
          },
        ]
  );
  const [confirm, setConfirm] = React.useState<string[]>(() =>
    rows.map(() => '')
  );
  const [authEnv, setAuthEnv] = React.useState('');
  const [permissionsEnv, setPermissionsEnv] = React.useState('');
  const [understood, setUnderstood] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const first = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => first.current?.focus(), [advanced]);
  React.useEffect(() => {
    if (!onCancel) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onCancel();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onCancel, saving]);

  const update = (i: number, change: Partial<Row>) =>
    setRows((all) => all.map((row, j) => (i === j ? { ...row, ...change } : row)));

  const collect = (): AccountInput[] | string => {
    if (advanced) {
      const parsed = parseEnvironment(authEnv, permissionsEnv);
      return parsed.ok ? parsed.accounts : parsed.error;
    }
    const kept = rows.filter((row) => !row.removed);
    if (kept.length === 0) return t`Keep at least one account.`;
    const names = new Set<string>();
    for (const [i, row] of rows.entries()) {
      if (row.removed) continue;
      const name = usernameProblem(row.username);
      if (name) return name;
      if (names.has(row.username)) return t`Each username can be used once.`;
      names.add(row.username);
      if (row.existing && !row.password) continue;
      const pass = passwordProblem(row.password, MIN_PASSWORD);
      if (pass) return `${row.username}: ${pass}`;
      if (row.password !== confirm[i])
        return `${row.username}: ${t`The passwords do not match.`}`;
    }
    return kept.map((row) => ({
      username: row.username,
      password: row.password,
      permissions: row.permissions,
      keep: row.existing && !row.password,
    }));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const result = collect();
    if (typeof result === 'string') return setError(result);
    if (managing && !understood)
      return setError(
        t`Confirm that you understand how changing accounts affects existing configurations.`
      );
    setError(null);
    setSaving(true);
    const problem = await saveAccounts(result, managing);
    setSaving(false);
    if (problem) setError(problem);
    else setSaved(true);
  };

  if (saved)
    return (
      <main className={panel}>
        <section
          role="status"
          className="mx-auto flex min-h-full max-w-xl flex-col justify-center gap-3 p-8"
        >
          <h1 className="text-2xl font-semibold">
            <Trans>Restarting the local server with your account…</Trans>
          </h1>
          <p className="text-gray-300">
            <Trans>The app checks the account against the built-in Usenet service, then continues.</Trans>
          </p>
        </section>
      </main>
    );

  return (
    <main className={panel}>
      <form
        onSubmit={submit}
        className="mx-auto flex min-h-full max-w-2xl flex-col justify-center gap-6 p-8"
        aria-labelledby="account-setup-title"
      >
        <div className="flex flex-col gap-3">
          <img src="./logo.png" alt="AIOStreams" className="h-14 w-14 object-contain" />
          <h1 id="account-setup-title" className="text-3xl font-semibold">
            {managing ? t`AIOStreams accounts` : t`Create your AIOStreams account`}
          </h1>
          {!managing && (
            <p className="text-gray-300">
              <Trans>This app runs its own private AIOStreams server on this computer. Like the AIOSTREAMS_AUTH setting of a Docker install, an account here signs you in to that server and authorises the built-in Usenet streaming engine.</Trans>
            </p>
          )}
          <p className="text-sm text-gray-400">
            <Trans>This is not your Usenet provider login. NNTP provider usernames and passwords go in Server settings under Usenet providers. A configuration password or PIN is separate too.</Trans>
          </p>
        </div>

        <div role="tablist" className="flex gap-2">
          {[false, true].map((mode) => (
            <button
              key={String(mode)}
              type="button"
              role="tab"
              aria-selected={advanced === mode}
              onClick={() => {
                setAdvanced(mode);
                setError(null);
              }}
              className={`rounded-lg px-3 py-2 text-sm ${advanced === mode ? 'bg-white/15 text-white' : 'text-gray-300 hover:bg-white/5'}`}
            >
              {mode ? t`Environment variables` : t`Accounts`}
            </button>
          ))}
        </div>

        {advanced ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-gray-400">
              <Trans>Paste the same values you would put in a Docker .env file. Users without a permissions entry are administrators, as in upstream AIOStreams. This replaces every account.</Trans>
            </p>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-mono text-gray-300">AIOSTREAMS_AUTH</span>
              <textarea
                ref={(element) => {
                  first.current = element;
                }}
                value={authEnv}
                onChange={(e) => setAuthEnv(e.target.value)}
                placeholder="user1:password1,user2:password2"
                spellCheck={false}
                autoComplete="off"
                rows={2}
                className={`${field} font-mono`}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-mono text-gray-300">
                AIOSTREAMS_AUTH_PERMISSIONS
              </span>
              <textarea
                value={permissionsEnv}
                onChange={(e) => setPermissionsEnv(e.target.value)}
                placeholder="user1=admin,user2=service|proxy"
                spellCheck={false}
                autoComplete="off"
                rows={2}
                className={`${field} font-mono`}
              />
            </label>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {rows.map((row, i) => (
              <div
                key={i}
                className="flex flex-col gap-3 rounded-xl border border-white/10 p-4"
              >
              <fieldset
                disabled={row.removed}
                className={`flex flex-col gap-3 ${row.removed ? 'opacity-50' : ''}`}
              >
                <label className="flex flex-col gap-1.5 text-sm">
                  <span className="text-gray-300">{t`Username`}</span>
                  <input
                    ref={
                      i === 0
                        ? (element) => {
                            first.current = element;
                          }
                        : undefined
                    }
                    value={row.username}
                    readOnly={row.existing}
                    onChange={(e) => update(i, { username: e.target.value })}
                    autoComplete="username"
                    spellCheck={false}
                    className={field}
                  />
                </label>
                <PasswordField
                  id={`account-password-${i}`}
                  label={row.existing ? t`New password (leave empty to keep)` : t`Password`}
                  value={row.password}
                  onChange={(password) => update(i, { password })}
                  autoComplete="new-password"
                />
                {(!row.existing || row.password) && (
                  <PasswordField
                    id={`account-confirm-${i}`}
                    label={t`Confirm password`}
                    value={confirm[i] ?? ''}
                    onChange={(value) =>
                      setConfirm((all) => {
                        const next = [...all];
                        next[i] = value;
                        return next;
                      })
                    }
                    autoComplete="new-password"
                  />
                )}
                {!managing ? (
                  <p className="text-sm text-gray-400">
                    <Trans>This account is the administrator: full access, including built-in Usenet streaming. You can add accounts with fewer permissions later in Settings, Local server.</Trans>
                  </p>
                ) : (
                <details className="text-sm" open>
                  <summary className="cursor-pointer text-gray-300">
                    <Trans>Permissions</Trans>
                  </summary>
                  <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                    {PERMISSIONS.map((permission) => (
                      <label key={permission} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={row.permissions.includes(permission)}
                          onChange={(e) =>
                            update(i, {
                              permissions: e.target.checked
                                ? [...row.permissions, permission]
                                : row.permissions.filter((p) => p !== permission),
                            })
                          }
                        />
                        <span>{permissionLabel(permission)}</span>
                      </label>
                    ))}
                  </div>
                  {!canStreamUsenet(row.permissions) && (
                    <p className="mt-2 text-amber-300">
                      <Trans>Without Administrator or Built-in Usenet streaming, this account cannot stream from your Usenet providers.</Trans>
                    </p>
                  )}
                </details>
                )}
              </fieldset>
                {managing && (
                  <button
                    type="button"
                    onClick={() => update(i, { removed: !row.removed })}
                    className="self-start text-sm text-gray-300 underline underline-offset-4 hover:text-white"
                  >
                    {row.removed ? t`Keep this account` : t`Remove this account`}
                  </button>
                )}
              </div>
            ))}
            {managing && (
              <Button
                type="button"
                intent="gray-outline"
                className="self-start"
                onClick={() => {
                  setRows((all) => [
                    ...all,
                    {
                      username: '',
                      password: '',
                      permissions: ['admin'],
                      existing: false,
                      removed: false,
                    },
                  ]);
                  setConfirm((all) => [...all, '']);
                }}
              >
                <Trans>Add account</Trans>
              </Button>
            )}
          </div>
        )}

        {managing && (
          <div className="flex flex-col gap-2 rounded-xl border border-amber-400/30 bg-amber-400/5 p-4 text-sm">
            <p className="text-amber-200">
              <Trans>Configurations store an account as username:password, for example in the built-in AIOStreams Usenet service or the proxy. If you change that account's password or remove it, those configurations stop working until you paste the new credential into them. Accounts you leave unchanged keep working.</Trans>
            </p>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={understood}
                onChange={(e) => setUnderstood(e.target.checked)}
              />
              <span>
                <Trans>I understand. Restart the local server with these accounts.</Trans>
              </span>
            </label>
          </div>
        )}

        {error && (
          <p role="alert" className="rounded-lg bg-red-500/10 p-3 text-sm text-red-300">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" intent="white" loading={saving}>
            {managing ? t`Save accounts` : t`Create account`}
          </Button>
          {onCancel && (
            <Button type="button" intent="gray-outline" onClick={onCancel}>
              <Trans>Cancel</Trans>
            </Button>
          )}
          {onSkip && (
            <Button type="button" intent="gray-outline" onClick={onSkip}>
              <Trans>Skip for now</Trans>
            </Button>
          )}
          {onUseRemote && (
            <button
              type="button"
              onClick={onUseRemote}
              className="text-sm text-gray-300 underline underline-offset-4 hover:text-white"
            >
              <Trans>Use a remote server instead</Trans>
            </button>
          )}
        </div>
      </form>
    </main>
  );
}

/** After saving: the server restarted; show the result and the next steps. */
export function AccountReady({
  credential,
  accounts,
  onOpenProviders,
  onOpenConfiguration,
  onBrowse,
}: {
  credential: string;
  accounts: EmbeddedAccount[];
  onOpenProviders(): void;
  onOpenConfiguration(): void;
  onBrowse(): void;
}) {
  const username = credential.slice(0, credential.indexOf(':'));
  const account = accounts.find((a) => a.username === username);
  const [shown, setShown] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const heading = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => heading.current?.focus(), []);
  const ok = account?.usenet === true;

  return (
    <main className={panel}>
      <section className="mx-auto flex min-h-full max-w-2xl flex-col justify-center gap-6 p-8">
        <div className="flex flex-col gap-3">
          <h1 ref={heading} tabIndex={-1} className="text-3xl font-semibold focus:outline-none">
            {ok ? t`Your account is ready` : t`Your account was saved`}
          </h1>
          <p role="status" className={ok ? 'text-emerald-300' : 'text-amber-300'}>
            {ok
              ? t`The local server accepted this account for built-in Usenet streaming.`
              : account?.detail || t`The local server did not accept this account for built-in Usenet streaming. Check its permissions in Server settings.`}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-sm text-gray-300">
            <Trans>Your AIOStreams credential, in the username:password form configurations use:</Trans>
          </p>
          <div className="flex flex-wrap gap-2">
            <code className="min-w-0 flex-1 break-all rounded-lg border border-white/15 bg-black/30 px-3 py-2.5 font-mono text-sm">
              {shown ? credential : `${username}:${'•'.repeat(10)}`}
            </code>
            <Button type="button" intent="gray-outline" onClick={() => setShown((s) => !s)}>
              {shown ? t`Hide` : t`Show`}
            </Button>
            <Button
              type="button"
              intent="white"
              onClick={() =>
                void copyToClipboard(credential, { onSuccess: () => setCopied(true) })
              }
            >
              {copied ? t`Copied` : t`Copy`}
            </Button>
          </div>
          <p className="text-xs text-gray-500">
            <Trans>The app shows this once. It stays saved, protected for your Windows user, and you can change it later in Diagnostics.</Trans>
          </p>
        </div>

        <ol className="flex list-decimal flex-col gap-3 pl-5 text-gray-200">
          <li>
            <Trans>Add your NNTP providers (host, port, SSL, connections, provider username and password) in Usenet providers.</Trans>{' '}
            <button type="button" onClick={onOpenProviders} className="underline underline-offset-4 hover:text-white">
              <Trans>Open Usenet providers</Trans>
            </button>
          </li>
          <li>
            <Trans>In your configuration, add the AIOStreams service (built-in Usenet) and paste the credential above as its AIOStreams auth token. Add your indexers there too.</Trans>{' '}
            <button type="button" onClick={onOpenConfiguration} className="underline underline-offset-4 hover:text-white">
              <Trans>Open configuration</Trans>
            </button>
          </li>
        </ol>

        <div>
          <Button type="button" intent="white" onClick={onBrowse}>
            <Trans>Ready to browse</Trans>
          </Button>
        </div>
      </section>
    </main>
  );
}

/** The permanent entry in Diagnostics. */
export function AccountsSummary({
  accounts,
  accountsError,
  onManage,
}: {
  accounts: EmbeddedAccount[];
  accountsError?: string | null;
  onManage(): void;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-white/10 p-4">
      <h2 className="text-lg font-semibold">
        <Trans>AIOStreams accounts</Trans>
      </h2>
      {accountsError ? (
        <p role="alert" className="text-sm text-red-300">
          {accountsError}
        </p>
      ) : accounts.length === 0 ? (
        <p className="text-sm text-amber-300">
          <Trans>No account yet. Built-in Usenet streaming needs one.</Trans>
        </p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {accounts.map((account) => (
            <li key={account.username} className="flex flex-wrap items-baseline gap-x-3">
              <span className="font-mono">{account.username}</span>
              <span className="text-gray-400">{account.permissions.join(', ') || 'none'}</span>
              <span className={account.usenet ? 'text-emerald-300' : 'text-amber-300'}>
                {account.usenet === true
                  ? t`Usenet streaming: accepted`
                  : account.usenet === false
                    ? t`Usenet streaming: not accepted`
                    : t`Usenet streaming: not checked yet`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!accountsError && (
        <Button type="button" intent="gray-outline" className="self-start" onClick={onManage}>
          {accounts.length ? t`Change accounts` : t`Create account`}
        </Button>
      )}
    </section>
  );
}
