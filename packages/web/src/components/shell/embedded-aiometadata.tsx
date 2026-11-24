/**
 * AIOStreams Integrated: Settings → Local server → AIOMetadata. The app runs
 * AIOMetadata privately on this computer (packages/desktop/app/src/backend/aiometadata.rs);
 * the user configures it in a browser and adds its manifest URL to AIOStreams
 * as a custom addon. Shown only in the integrated desktop app.
 */
import React from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Button } from '@aiostreams/ui/button';
import { copyToClipboard } from '@aiostreams/ui/utils/clipboard';
import { appBridge } from '@/lib/hosts/shell/bridge';
import { CONFIGURE_PATH, type BackendState } from '@/lib/embedded-shell';
import {
  SettingsCard,
  SettingsRow,
} from '@/app/settings/_components/settings-card';

type Status = NonNullable<BackendState['aiometadata']>;

export function AioMetadataCard({
  status,
  local,
  openServer,
  manageKey,
}: {
  status: Status | undefined;
  /** The AIOStreams server on this computer is in use, so its configuration can open. */
  local: boolean;
  openServer(path: string): void;
  manageKey(): void;
}) {
  const [copied, setCopied] = React.useState(false);
  if (!status || status.state === 'unavailable') return null;
  const url = status.state === 'ready' ? status.url : null;
  const example =
    status.manifestHint ?? 'http://127.0.0.1:3232/stremio/<your-uuid>/manifest.json';
  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <SettingsCard title={t`AIOMetadata`}>
      <SettingsRow label={t`Status`}>
        <span
          role={status.state === 'failed' ? 'alert' : 'status'}
          className="text-sm text-[--muted]"
        >
          {status.message}
        </span>
      </SettingsRow>
      {url && (
        <SettingsRow label={t`Address`}>
          <span className="flex flex-wrap items-center gap-2">
            <span className="break-all font-mono text-sm text-[--muted]">{url}</span>
            <Button size="sm" intent="gray-outline" onClick={() => void copy()}>
              {copied ? t`Copied` : t`Copy`}
            </Button>
          </span>
        </SettingsRow>
      )}
      <SettingsRow label={t`Open`}>
        <span className="flex flex-wrap gap-2">
          {url && (
            // Opens in the system browser: AIOMetadata's pages never get the app bridge.
            <a
              href={`${url}/configure`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded-lg border border-[--border] px-3 py-1.5 text-sm hover:bg-white/5"
            >
              <Trans>Configure AIOMetadata</Trans>
            </a>
          )}
          {local && (
            <Button size="sm" intent="gray-outline" onClick={() => openServer(CONFIGURE_PATH)}>
              <Trans>AIOStreams addons</Trans>
            </Button>
          )}
          <Button
            size="sm"
            intent="gray-outline"
            disabled={status.state === 'starting'}
            onClick={() => appBridge()?.send({ type: 'backend-aiometadata-restart' })}
          >
            <Trans>Restart AIOMetadata</Trans>
          </Button>
        </span>
      </SettingsRow>
      <SettingsRow label={t`Admin key`}>
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-[--muted]">
            {status.adminKey === 'set'
              ? t`Set, protected for your Windows user`
              : t`Not set: AIOMetadata's dashboard is closed`}
          </span>
          <Button size="sm" intent="gray-outline" onClick={manageKey}>
            {status.adminKey === 'set' ? t`Change` : t`Set admin key`}
          </Button>
        </span>
      </SettingsRow>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-[--muted]">
        <li>
          <Trans>
            Open Configure AIOMetadata. It opens in your browser. Add your API keys and catalogs, then save. AIOMetadata shows your install (manifest) URL.
          </Trans>
        </li>
        <li>
          <Trans>
            In AIOStreams addons, add a Custom addon and paste that manifest URL. It looks like {example}.
          </Trans>
        </li>
      </ol>
      <p className="text-sm text-[--muted]">
        <Trans>
          AIOMetadata runs only on this computer, separately from the AIOStreams server, and keeps its settings in your user folder. It is a separate project by cedya77, licensed AGPL-3.0 and FSL-1.1; this build is not endorsed by it.
        </Trans>{' '}
        <a
          href="https://github.com/cedya77/aiometadata"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-4"
        >
          <Trans>AIOMetadata project</Trans>
        </a>
      </p>
    </SettingsCard>
  );
}

const field =
  'w-full rounded-lg border border-white/20 bg-[#18181d] px-3 py-2.5 font-mono text-white placeholder:text-gray-500 focus:border-white/50 focus:outline-none';

/** Same rules as admin_key_problem() in backend/aiometadata.rs. */
export function adminKeyProblem(key: string): string | null {
  if ([...key].length < 12) return t`Use at least 12 characters.`;
  if ([...key].length > 256) return t`Use at most 256 characters.`;
  if (!/^[\x21-\x7e]+$/.test(key)) return t`Use letters, digits and symbols only, without spaces.`;
  return null;
}

/** 32 random characters, safe in the X-Admin-Key header. */
export function generateAdminKey(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  // 256 is not a multiple of the alphabet; the tiny bias does not matter for a 32-character key.
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function saveAdminKey(request: { key: string } | { skip: true }): Promise<string | null> {
  const bridge = appBridge();
  if (!bridge) return Promise.resolve(t`The desktop app is not available.`);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(t`The app did not answer. Open the logs and try again.`);
    }, 15_000);
    const unsubscribe = bridge.subscribe((message) => {
      if (message.type !== 'backend-aiometadata-result') return;
      clearTimeout(timer);
      unsubscribe();
      resolve(message.ok ? null : message.message || t`The admin key was not saved.`);
    });
    bridge.send({ type: 'backend-aiometadata-admin-key', ...request });
  });
}

/**
 * First run (after the AIOStreams account): choose AIOMetadata's ADMIN_KEY,
 * the key its dashboard asks for. Also opened from Settings to change it.
 */
export function AioMetadataKeySetup({
  changing,
  onDone,
}: {
  /** Opened from Settings: Cancel instead of Skip. */
  changing: boolean;
  onDone(): void;
}) {
  const [key, setKey] = React.useState(() => (changing ? '' : generateAdminKey()));
  const [shown, setShown] = React.useState(!changing);
  const [copied, setCopied] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const heading = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => heading.current?.focus(), []);
  const problem = key ? adminKeyProblem(key) : null;

  const submit = async (request: { key: string } | { skip: true }) => {
    setSaving(true);
    setError(null);
    const failure = await saveAdminKey(request);
    setSaving(false);
    if (failure) setError(failure);
    else onDone();
  };

  return (
    <main className="fixed inset-0 z-[60] overflow-auto bg-[#101014] text-white">
      <form
        className="mx-auto flex min-h-full max-w-2xl flex-col justify-center gap-6 p-8"
        onSubmit={(event) => {
          event.preventDefault();
          if (key && !problem) void submit({ key });
        }}
      >
        <div className="flex flex-col gap-3">
          <h1 ref={heading} tabIndex={-1} className="text-3xl font-semibold focus:outline-none">
            {changing ? t`Change the AIOMetadata admin key` : t`Set up AIOMetadata`}
          </h1>
          <p className="text-gray-300">
            <Trans>
              AIOMetadata runs on this computer beside AIOStreams. Its admin key opens AIOMetadata's dashboard (statistics, cache and server settings). It is AIOMetadata's ADMIN_KEY setting.
            </Trans>
          </p>
        </div>

        <label htmlFor="aiometadata-admin-key" className="flex flex-col gap-1.5 text-sm">
          <span className="text-gray-300">
            <Trans>Admin key</Trans>
          </span>
          <span className="flex flex-wrap gap-2">
            <input
              id="aiometadata-admin-key"
              type={shown ? 'text' : 'password'}
              value={key}
              onChange={(e) => {
                setKey(e.target.value.trim());
                setCopied(false);
              }}
              autoComplete="new-password"
              spellCheck={false}
              aria-invalid={!!problem}
              aria-describedby="aiometadata-admin-key-help"
              className={`${field} min-w-0 flex-1`}
            />
            <Button type="button" intent="gray-outline" onClick={() => setShown((s) => !s)} aria-pressed={shown}>
              {shown ? t`Hide` : t`Show`}
            </Button>
            <Button
              type="button"
              intent="gray-outline"
              onClick={() => {
                setKey(generateAdminKey());
                setShown(true);
                setCopied(false);
              }}
            >
              <Trans>Generate</Trans>
            </Button>
            <Button
              type="button"
              intent="gray-outline"
              disabled={!key}
              onClick={() => void copyToClipboard(key, { onSuccess: () => setCopied(true) })}
            >
              {copied ? t`Copied` : t`Copy`}
            </Button>
          </span>
          <span id="aiometadata-admin-key-help" className={problem ? 'text-amber-300' : 'text-xs text-gray-500'}>
            {problem ??
              t`Copy it somewhere safe: AIOMetadata's dashboard asks for it. The app keeps it protected for your Windows user and passes it to AIOMetadata at every start.`}
          </span>
        </label>

        {error && (
          <p role="alert" className="text-red-300">
            {error}
          </p>
        )}

        <div className="flex flex-wrap gap-3">
          <Button type="submit" intent="white" loading={saving} disabled={!key || !!problem}>
            {changing ? t`Save and restart AIOMetadata` : t`Save and continue`}
          </Button>
          {changing ? (
            <Button type="button" intent="gray-outline" disabled={saving} onClick={onDone}>
              <Trans>Cancel</Trans>
            </Button>
          ) : (
            <Button type="button" intent="gray-outline" disabled={saving} onClick={() => void submit({ skip: true })}>
              <Trans>Skip for now</Trans>
            </Button>
          )}
        </div>
        {!changing && (
          <p className="text-xs text-gray-500">
            <Trans>
              Without a key, AIOMetadata works for catalogs and metadata but its dashboard stays closed. Set one later in Settings → Local server → AIOMetadata.
            </Trans>
          </p>
        )}
      </form>
    </main>
  );
}
