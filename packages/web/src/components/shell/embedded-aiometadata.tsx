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
}: {
  status: Status | undefined;
  /** The AIOStreams server on this computer is in use, so its configuration can open. */
  local: boolean;
  openServer(path: string): void;
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
