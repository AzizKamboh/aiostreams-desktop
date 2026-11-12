import React from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@aiostreams/ui/button';
import { appBridge, type ShellAnswer } from '@/lib/hosts/shell/bridge';
import { openLogs, requestDiagnostics, useShellLinks } from '@/lib/hosts/shell';
import { storage } from '@/lib/storage';
import { SplashEnd } from '@/lib/splash';
import { navigate, to } from '@/lib/paths';
import {
  embeddedOrigin,
  onOpenConfiguration,
  setEmbeddedOrigin,
} from '@/lib/embedded-backend';
import {
  hydrateEmbeddedStorage,
  persistEmbeddedStorage,
} from '@/lib/embedded-storage';
import { parseAppLink } from '@/lib/app-links';
import { findServer, sameServer } from '@/lib/jellyfin/servers';
import { sendRemote } from '@/lib/remote/commands';
import { party } from '@/lib/party/party';
import { toast } from 'sonner';

type BackendState = ShellAnswer<'backend-state'>;
type Tab = 'browse' | 'configure' | 'diagnostics';
type Mode = 'local' | 'remote';
const MODE_KEY = 'aiostreams-desktop-backend-mode';
const VISITED_KEY = 'aiostreams-desktop-configured';
const API_PATH_KEY = 'aiostreams-desktop-local-api-path';

function LocalLinks({
  base,
  onServer,
  onBrowse,
}: {
  base: string;
  onServer(path: string): void;
  onBrowse(): void;
}) {
  useShellLinks((raw) => {
    const link = parseAppLink(raw);
    if (!link) return;
    if (link.kind === 'route') {
      onBrowse();
      return navigate(link.path);
    }
    if (link.kind === 'party') {
      onBrowse();
      return party.hold(link.invite);
    }
    if (link.kind === 'remote') {
      if (!link.server || sameServer(link.server, base)) {
        onBrowse();
        return sendRemote(link.command);
      }
    }
    if (
      link.kind === 'server' &&
      new URL(link.address).origin === new URL(base).origin
    ) {
      void findServer(link.address)
        .then((server) => onServer(new URL(server.base).pathname))
        .catch(() =>
          toast.error(
            t`The local configuration could not be opened. Check Server settings.`
          )
        );
      return;
    }
    toast.info(
      t`To connect to another server, select the remote connection in Diagnostics.`
    );
  });
  return null;
}

function useBackend(): { state: BackendState; hydrated: boolean } {
  const [state, setState] = React.useState<BackendState>({
    type: 'backend-state',
    state: 'starting',
  });
  const [hydrated, setHydrated] = React.useState(false);
  const restored = React.useRef(false);
  const stopPersistence = React.useRef<(() => void) | undefined>(undefined);
  React.useEffect(() => {
    const bridge = appBridge();
    if (!bridge) return;
    if (restored.current) stopPersistence.current = persistEmbeddedStorage();
    const unsubscribe = bridge.subscribe((message) => {
      if (message.type !== 'backend-state') return;
      if (!restored.current && message.storage) {
        hydrateEmbeddedStorage(message.storage, embeddedOrigin(message.url));
        restored.current = true;
        setHydrated(true);
        stopPersistence.current = persistEmbeddedStorage();
      }
      setState(message);
    });
    bridge.send({ type: 'backend-status' });
    // Status requests recover a missed event after a WebView reload.
    const timer = setInterval(
      () => bridge.send({ type: 'backend-status' }),
      5000
    );
    return () => {
      clearInterval(timer);
      unsubscribe();
      stopPersistence.current?.();
    };
  }, []);
  return { state, hydrated };
}

function statusLabel(state: BackendState['state']): string {
  switch (state) {
    case 'starting':
      return t`Starting the local server…`;
    case 'ready':
      return t`Local server is running`;
    case 'failed':
      return t`The local server could not run`;
    case 'stopped':
      return t`Local server is stopped`;
  }
}

/** The existing browser and player, with a local backend and its original dashboard. */
export function EmbeddedDesktop({
  browse,
  remote,
}: {
  browse(base: string, changeServer: () => void): React.ReactNode;
  remote: React.ReactNode;
}) {
  const { state, hydrated } = useBackend();
  if (!hydrated)
    return (
      <>
        <SplashEnd />
        <main className="fixed inset-0 flex flex-col items-center justify-center gap-5 bg-[#101014] p-8 text-white">
          <h1 className="text-2xl font-semibold">{statusLabel(state.state)}</h1>
          <p role="status">
            {state.message || t`Restoring your saved settings…`}
          </p>
          <Button intent="gray-outline" onClick={openLogs}>
            <Trans>Open logs</Trans>
          </Button>
          {state.state === 'failed' && (
            <Button
              intent="white"
              onClick={() => appBridge()?.send({ type: 'backend-restart' })}
            >
              <Trans>Restart backend</Trans>
            </Button>
          )}
        </main>
      </>
    );
  return <EmbeddedContent state={state} browse={browse} remote={remote} />;
}

function EmbeddedContent({
  state,
  browse,
  remote,
}: {
  state: BackendState;
  browse(base: string, changeServer: () => void): React.ReactNode;
  remote: React.ReactNode;
}) {
  const origin = embeddedOrigin(state.url);
  const ready = state.state === 'ready' && origin !== null;
  const queryClient = useQueryClient();
  const [mode, setMode] = React.useState<Mode>(() =>
    storage.get<Mode>(MODE_KEY) === 'remote' ? 'remote' : 'local'
  );
  const [tab, setTab] = React.useState<Tab>(() =>
    storage.get<Mode>(MODE_KEY) === 'remote' ||
    storage.get<boolean>(VISITED_KEY)
      ? 'browse'
      : 'configure'
  );
  const [configurePath, setConfigurePath] =
    React.useState('/stremio/configure');
  const [apiPath, setApiPath] = React.useState(() => {
    const saved = storage.get<string>(API_PATH_KEY);
    return saved &&
      (saved === '/jellyfin' || saved.startsWith('/jellyfin/')) &&
      !saved.includes('?') &&
      !saved.includes('#')
      ? saved
      : '/jellyfin';
  });
  const [diagnostics, setDiagnostics] = React.useState('');
  const [readingDiagnostics, setReadingDiagnostics] = React.useState(false);
  const [playing, setPlaying] = React.useState(() =>
    location.hash.startsWith('#/play/')
  );

  React.useEffect(() => {
    setEmbeddedOrigin(origin);
    return () => setEmbeddedOrigin(null);
  }, [origin]);
  React.useEffect(
    () =>
      onOpenConfiguration((url) => {
        const parsed = new URL(url);
        setConfigurePath(parsed.pathname + parsed.search + parsed.hash);
        setTab('configure');
        setMode('local');
      }),
    []
  );
  React.useEffect(() => {
    const changed = () => setPlaying(location.hash.startsWith('#/play/'));
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);

  const chooseMode = (next: Mode) => {
    if (next === mode) return;
    appBridge()?.send({ type: 'player-stop' });
    appBridge()?.send({ type: 'player-stop', external: true });
    navigate(to.home, { replace: true });
    queryClient.clear();
    storage.set(MODE_KEY, next);
    // The native shell chooses its trusted page origin from the persisted mode.
    // storage.set synchronously snapshots it before this status request.
    appBridge()?.send({ type: 'backend-status' });
    setMode(next);
    setTab('browse');
  };
  const chooseTab = (next: Tab) => {
    if (next !== 'browse') {
      appBridge()?.send({ type: 'player-stop' });
      appBridge()?.send({ type: 'player-stop', external: true });
      navigate(to.home, { replace: true });
    }
    if (next === 'browse') storage.set(VISITED_KEY, true);
    setTab(next);
  };
  const restart = () => appBridge()?.send({ type: 'backend-restart' });
  const readDiagnostics = async () => {
    setReadingDiagnostics(true);
    try {
      setDiagnostics(await requestDiagnostics(origin));
    } catch {
      setDiagnostics(
        t`Could not read diagnostics. Use Open logs to inspect the log files.`
      );
    } finally {
      setReadingDiagnostics(false);
    }
  };
  const showPane = tab !== 'browse' || (mode === 'local' && !ready);
  const base = `${origin}${apiPath}`;

  return (
    <>
      <SplashEnd />
      {mode === 'local' && ready && (
        <LocalLinks
          base={base}
          onBrowse={() => chooseTab('browse')}
          onServer={(path) => {
            if (path !== '/jellyfin' && !path.startsWith('/jellyfin/')) return;
            storage.set(API_PATH_KEY, path);
            setApiPath(path);
            queryClient.clear();
            chooseTab('browse');
          }}
        />
      )}
      {mode === 'remote' && tab === 'browse'
        ? remote
        : ready && tab === 'browse'
          ? browse(base, () => chooseMode('remote'))
          : null}
      {showPane && (
        <main className="fixed inset-x-0 bottom-20 top-10 z-40 overflow-auto bg-[#101014] text-white">
          {tab === 'configure' && ready && mode === 'local' ? (
            <iframe
              title={t`Local server configuration`}
              src={`${origin}${configurePath}`}
              className="h-full w-full border-0 bg-[#101014]"
              referrerPolicy="no-referrer"
            />
          ) : (
            <section className="mx-auto flex min-h-full max-w-3xl flex-col justify-center gap-6 p-8">
              <div>
                <p className="mb-3 text-sm font-medium uppercase tracking-widest text-gray-400">
                  <Trans>AIOStreams Desktop</Trans>
                </p>
                <h1 className="text-3xl font-semibold">
                  {statusLabel(state.state)}
                </h1>
                <p
                  className="mt-3 whitespace-pre-wrap text-gray-300"
                  role={state.state === 'failed' ? 'alert' : 'status'}
                >
                  {state.message ||
                    (state.state === 'starting'
                      ? t`Preparing your saved settings and checking the server. This can take a moment on the first launch.`
                      : ready
                        ? t`Your settings and server data stay on this computer.`
                        : t`Open the logs for details, then restart the backend to try again.`)}
                </p>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-sm text-gray-400">
                <dt>
                  <Trans>AIOStreams Integrated</Trans>
                </dt>
                <dd>{appBridge()?.integratedVersion ?? '?'}</dd>
                <dt>
                  <Trans>Desktop client (upstream)</Trans>
                </dt>
                <dd>{appBridge()?.version ?? '?'}</dd>
                <dt>
                  <Trans>Server (upstream)</Trans>
                </dt>
                <dd>{__SERVER_VERSION__}</dd>
                {origin && (
                  <>
                    <dt>
                      <Trans>Local server</Trans>
                    </dt>
                    <dd className="break-all">{origin}</dd>
                  </>
                )}
              </dl>
              <div className="flex flex-wrap gap-3">
                <Button
                  intent="white"
                  onClick={restart}
                  disabled={state.state === 'starting'}
                >
                  <Trans>Restart backend</Trans>
                </Button>
                <Button intent="gray-outline" onClick={openLogs}>
                  <Trans>Open logs</Trans>
                </Button>
                <Button
                  intent="gray-outline"
                  onClick={() => void readDiagnostics()}
                  loading={readingDiagnostics}
                >
                  <Trans>Read diagnostics</Trans>
                </Button>
              </div>
              {ready && (
                <a
                  href={`${origin}/__desktop/source`}
                  download
                  className="text-sm text-gray-300 underline underline-offset-4 hover:text-white"
                >
                  <Trans>Download source code</Trans>
                </a>
              )}
              {diagnostics && (
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xl border border-white/10 bg-black/30 p-4 text-xs text-gray-300">
                  {diagnostics}
                </pre>
              )}
              <label className="flex flex-col gap-2 text-sm">
                <span>
                  <Trans>Server connection</Trans>
                </span>
                <select
                  aria-label={t`Server connection`}
                  value={mode}
                  onChange={(event) => chooseMode(event.target.value as Mode)}
                  className="rounded-lg border border-white/20 bg-[#18181d] p-3"
                >
                  <option value="local">{t`Embedded server on this computer`}</option>
                  <option value="remote">{t`Remote AIOStreams or Jellyfin server`}</option>
                </select>
              </label>
              {mode === 'remote' && (
                <p className="text-sm text-gray-400">
                  <Trans>
                    Choose Browse to select a remote server. Only the server you
                    select receives its requests.
                  </Trans>
                </p>
              )}
            </section>
          )}
        </main>
      )}
      {(!playing || showPane) && (
        <nav
          aria-label={t`Desktop navigation`}
          className="fixed bottom-4 left-1/2 z-50 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-1 rounded-2xl border border-white/15 bg-[#1b1b22] p-2 shadow-xl"
        >
          <button
            type="button"
            onClick={() => chooseTab('browse')}
            aria-current={tab === 'browse' ? 'page' : undefined}
            className={`whitespace-nowrap rounded-xl px-4 py-3 text-sm ${tab === 'browse' ? 'bg-white/15 text-white' : 'text-gray-300 hover:bg-white/5'}`}
          >
            <Trans>Browse</Trans>
          </button>
          {mode === 'local' && (
            <button
              type="button"
              onClick={() => chooseTab('configure')}
              aria-current={tab === 'configure' ? 'page' : undefined}
              className={`whitespace-nowrap rounded-xl px-4 py-3 text-sm ${tab === 'configure' ? 'bg-white/15 text-white' : 'text-gray-300 hover:bg-white/5'}`}
            >
              <Trans>Server settings</Trans>
            </button>
          )}
          <button
            type="button"
            onClick={() => chooseTab('diagnostics')}
            aria-current={tab === 'diagnostics' ? 'page' : undefined}
            className={`whitespace-nowrap rounded-xl px-4 py-3 text-sm ${tab === 'diagnostics' ? 'bg-white/15 text-white' : 'text-gray-300 hover:bg-white/5'}`}
          >
            <Trans>Diagnostics</Trans>
          </button>
        </nav>
      )}
    </>
  );
}
