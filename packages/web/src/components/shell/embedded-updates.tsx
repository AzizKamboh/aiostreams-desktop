/**
 * AIOStreams Integrated: Settings → Updates. Replaces upstream's updates card
 * in the integrated app (apps.tsx) with the integrated updater's state: three
 * versions, channel, progress, times, errors, and actions. Never restarts
 * while something plays without asking.
 */
import React from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Button } from '@aiostreams/ui/button';
import { Select } from '@aiostreams/ui/select';
import { settings, useSetting } from '@/lib/settings';
import { usePlayback } from '@/lib/playback/session';
import {
  canRetry,
  checkIntegratedUpdate,
  installIntegratedUpdate,
  useIntegratedUpdate,
  type IntegratedUpdate,
} from '@/lib/embedded-updates';
import { SettingsCard, SettingsRow } from '@/app/settings/_components/settings-card';

function status(update: IntegratedUpdate | null): string {
  switch (update?.state) {
    case undefined:
      return t`Reading update status…`;
    case 'off': {
      const reason = update.offReason ?? '';
      return t`This copy does not update itself (${reason}). Install the app with Setup to get updates.`;
    }
    case 'idle':
      return t`Waiting for the first check.`;
    case 'checking':
      return t`Checking for updates…`;
    case 'downloading': {
      const version = update.latestVersion ?? '';
      const progress = update.progress ?? 0;
      return t`Downloading ${version}… ${progress}%`;
    }
    case 'ready': {
      const version = update.readyVersion ?? update.latestVersion ?? '';
      return t`Version ${version} is downloaded and verified. It installs when you close the app, or now with Install and restart.`;
    }
    case 'current':
      return t`Up to date.`;
    case 'error': {
      const error = update.lastError ?? '';
      return t`Update failed: ${error}. The app keeps working; it tries again later.`;
    }
  }
}

export function IntegratedUpdatesCard() {
  const update = useIntegratedUpdate();
  const [setting, setSetting] = useSetting(settings.app.updateChannel);
  const playing = !!usePlayback();
  const [confirming, setConfirming] = React.useState(false);
  // Upstream's setting: "nightly" selects the integrated Preview channel.
  const channel = setting === 'installed' ? (update?.installedChannel === 'preview' ? 'nightly' : 'stable') : setting;
  const busy = update?.state === 'checking' || update?.state === 'downloading';
  const off = !update || update.state === 'off';
  const button = 'w-full rounded-full sm:w-auto';
  const install = () => {
    if (playing) setConfirming(true);
    else installIntegratedUpdate(false);
  };
  return (
    // Upstream's layout: Channel and Status. Versions are in Settings → Local
    // server; errors are in the status line.
    <SettingsCard name="updates" title={t`Updates`}>
      <Select
        label={t`Channel`}
        help={t`Preview builds pass the same tests but arrive earlier and are more likely to have problems. Switching back to Stable waits for the next stable version; it never installs an older one.`}
        options={[
          { value: 'stable', label: t`Stable` },
          { value: 'nightly', label: t`Preview` },
        ]}
        value={channel}
        onValueChange={(v) => setSetting(v as 'stable' | 'nightly')}
      />
      <SettingsRow label={t`Status`} help={status(update)}>
        <span className="flex flex-wrap gap-2">
          {update?.state === 'ready' ? (
            <Button intent="white" className={button} onClick={install}>
              <Trans>Install and restart</Trans>
            </Button>
          ) : (
            <Button intent="gray-outline" className={button} loading={busy} disabled={off} onClick={checkIntegratedUpdate}>
              {canRetry(update) ? <Trans>Retry</Trans> : <Trans>Check for updates</Trans>}
            </Button>
          )}
          {update?.releaseNotesUrl && (
            <a
              href={update.releaseNotesUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="self-center text-sm underline underline-offset-4"
            >
              <Trans>Release notes</Trans>
            </a>
          )}
        </span>
      </SettingsRow>
      {update?.state === 'downloading' && (
        <div
          role="progressbar"
          aria-label={t`Download progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={update.progress ?? 0}
          className="h-1.5 overflow-hidden rounded-full bg-white/10"
        >
          <div className="h-full bg-[--brand] transition-[width]" style={{ width: `${update.progress ?? 0}%` }} />
        </div>
      )}
      {confirming && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg bg-amber-400/10 p-3 text-sm">
          <span>
            <Trans>Installing now stops what is playing. It also installs by itself when you close the app.</Trans>
          </span>
          <Button size="sm" intent="white" onClick={() => { setConfirming(false); installIntegratedUpdate(true); }}>
            <Trans>Stop and install</Trans>
          </Button>
          <Button size="sm" intent="gray-outline" onClick={() => setConfirming(false)}>
            <Trans>Later</Trans>
          </Button>
        </div>
      )}
    </SettingsCard>
  );
}
