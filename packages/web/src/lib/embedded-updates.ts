/**
 * AIOStreams Integrated: the integrated app's own updater (native
 * updates_integrated.rs). Its detailed state travels as integration-owned
 * `integrated-update-*` messages, so upstream's bridge protocol is unchanged;
 * upstream's `update-state` keeps driving its own prompt.
 */
import React from 'react';
import { appBridge } from './hosts/shell/bridge';
import { createLive, useLive } from './live-value';
import { parseUpdate, pollInterval, type IntegratedUpdate } from './embedded-update-state';

export * from './embedded-update-state';

const live = createLive<IntegratedUpdate | null>(null);
let subscribed = false;

function subscribe() {
  if (subscribed) return;
  const bridge = appBridge();
  if (!bridge?.backend) return;
  subscribed = true;
  bridge.subscribe((message) => {
    const update = parseUpdate(message);
    if (update) live.set(update);
  });
}

function send(type: string, extra: Record<string, unknown> = {}) {
  subscribe();
  appBridge()?.send({ type, ...extra });
}

export const requestUpdateStatus = () => send('integrated-update-status');
/** A manual check: also retries a download that failed several times. */
export const checkIntegratedUpdate = () => send('integrated-update-check');
/** Closes the app (stopping the local server normally) and installs. */
export const installIntegratedUpdate = (confirmed: boolean) =>
  send('integrated-update-install', { confirmed });

export function useIntegratedUpdate(): IntegratedUpdate | null {
  const update = useLive(live);
  const interval = pollInterval(update);
  React.useEffect(() => {
    requestUpdateStatus();
    const timer = window.setInterval(requestUpdateStatus, interval);
    return () => window.clearInterval(timer);
  }, [interval]);
  return update;
}
