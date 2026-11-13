/**
 * AIOStreams Integrated: Settings → Local server. Status, versions, accounts,
 * links into upstream's dashboard and configuration, restart, logs and the
 * local/remote switch. Shown only in the integrated desktop app.
 */
import React from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Button } from '@aiostreams/ui/button';
import { openLogs } from '@/lib/hosts/shell';
import { appBridge } from '@/lib/hosts/shell/bridge';
import { usePlayback } from '@/lib/playback/session';
import {
  CONFIGURE_PATH,
  DASHBOARD_PATH,
  USENET_PROVIDERS_PATH,
  useDesktopShell,
  type BackendMode,
} from '@/lib/embedded-shell';
import {
  SettingsCard,
  SettingsRow,
} from '@/app/settings/_components/settings-card';
import { AccountsSummary } from './embedded-accounts';

/** Restart and switching servers stop playback, so they ask first. */
type Pending = { kind: 'restart' } | { kind: 'mode'; mode: BackendMode };

export function LocalServerSection() {
  const shell = useDesktopShell();
  const playing = !!usePlayback();
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [diagnostics, setDiagnostics] = React.useState('');
  const [reading, setReading] = React.useState(false);
  if (!shell) return null;
  const { state, mode, local, origin } = shell;

  const act = (action: Pending) => {
    setPending(null);
    if (action.kind === 'restart') shell.restart();
    else shell.chooseMode(action.mode);
  };
  const request = (action: Pending) =>
    playing ? setPending(action) : act(action);
  const read = async () => {
    setReading(true);
    try {
      setDiagnostics(await shell.readDiagnostics());
    } catch {
      setDiagnostics(
        t`Could not read diagnostics. Use Open logs to inspect the log files.`
      );
    } finally {
      setReading(false);
    }
  };

  return (
    <>
      <SettingsCard title={t`Server`}>
        <SettingsRow label={t`Connection`}>
          <select
            aria-label={t`Server connection`}
            value={mode}
            onChange={(e) =>
              request({ kind: 'mode', mode: e.target.value as BackendMode })
            }
            className="rounded-lg border border-[--border] bg-transparent p-2 text-sm"
          >
            <option value="local">{t`Embedded server on this computer`}</option>
            <option value="remote">{t`Remote AIOStreams or Jellyfin server`}</option>
          </select>
        </SettingsRow>
        <SettingsRow label={t`Status`}>
          <span
            role={state.state === 'failed' ? 'alert' : 'status'}
            className="text-sm text-[--muted]"
          >
            {state.message}
          </span>
        </SettingsRow>
        {local && (
          <SettingsRow label={t`Open`}>
            <span className="flex flex-wrap gap-2">
              <Button size="sm" intent="gray-outline" onClick={() => shell.openServer(DASHBOARD_PATH)}>
                <Trans>Server dashboard</Trans>
              </Button>
              <Button size="sm" intent="gray-outline" onClick={() => shell.openServer(CONFIGURE_PATH)}>
                <Trans>Configuration</Trans>
              </Button>
              <Button size="sm" intent="gray-outline" onClick={() => shell.openServer(USENET_PROVIDERS_PATH)}>
                <Trans>Usenet providers</Trans>
              </Button>
            </span>
          </SettingsRow>
        )}
        {mode === 'local' && (
          <SettingsRow label={t`Troubleshooting`}>
            <span className="flex flex-wrap gap-2">
              <Button
                size="sm"
                intent="gray-outline"
                disabled={state.state === 'starting'}
                onClick={() => request({ kind: 'restart' })}
              >
                <Trans>Restart backend</Trans>
              </Button>
              <Button size="sm" intent="gray-outline" onClick={openLogs}>
                <Trans>Open logs</Trans>
              </Button>
              <Button size="sm" intent="gray-outline" loading={reading} onClick={() => void read()}>
                <Trans>Read diagnostics</Trans>
              </Button>
              {local && origin && (
                <a
                  href={`${origin}/__desktop/source`}
                  download
                  className="self-center text-sm underline underline-offset-4"
                >
                  <Trans>Download source code</Trans>
                </a>
              )}
            </span>
          </SettingsRow>
        )}
        {pending && (
          <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg bg-amber-400/10 p-3 text-sm">
            <span>
              {pending.kind === 'restart'
                ? t`Restarting the backend stops what is playing.`
                : t`Switching servers stops what is playing.`}
            </span>
            <Button size="sm" intent="white" onClick={() => act(pending)}>
              <Trans>Continue</Trans>
            </Button>
            <Button size="sm" intent="gray-outline" onClick={() => setPending(null)}>
              <Trans>Cancel</Trans>
            </Button>
          </div>
        )}
        {diagnostics && (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xl border border-white/10 bg-black/30 p-4 text-xs">
            {diagnostics}
          </pre>
        )}
      </SettingsCard>

      {local && (
        <AccountsSummary
          accounts={state.accounts ?? []}
          accountsError={state.accountsError}
          onManage={shell.manageAccounts}
        />
      )}

      <SettingsCard title={t`Versions`}>
        <SettingsRow label={t`App`}>
          <span className="text-sm text-[--muted]">{appBridge()?.integratedVersion ?? '?'}</span>
        </SettingsRow>
        <SettingsRow label={t`Desktop client (upstream)`}>
          <span className="text-sm text-[--muted]">{appBridge()?.version ?? '?'}</span>
        </SettingsRow>
        <SettingsRow label={t`Server (upstream)`}>
          <span className="text-sm text-[--muted]">{__SERVER_VERSION__}</span>
        </SettingsRow>
        {origin && (
          <SettingsRow label={t`Local server`}>
            <span className="break-all font-mono text-sm text-[--muted]">{origin}</span>
          </SettingsRow>
        )}
      </SettingsCard>

      <SettingsCard title={t`Shortcuts`}>
        <SettingsRow label={t`Server dashboard`}>
          <kbd className="font-mono text-sm">Ctrl+,</kbd>
        </SettingsRow>
        <SettingsRow label={t`Configuration`}>
          <kbd className="font-mono text-sm">Ctrl+Shift+,</kbd>
        </SettingsRow>
        <SettingsRow label={t`Back to the library`}>
          <span className="text-sm text-[--muted]">
            <Trans>Escape, or Browse in the dashboard sidebar</Trans>
          </span>
        </SettingsRow>
      </SettingsCard>
    </>
  );
}
