import React from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@aiostreams/ui/button';
import { appBridge } from '@/lib/hosts/shell/bridge';
import { openLogs, requestDiagnostics, useShellLinks } from '@/lib/hosts/shell';
import { storage } from '@/lib/storage';
import { SplashEnd } from '@/lib/splash';
import { navigate, to } from '@/lib/paths';
import { playbackNow } from '@/lib/playback/session';
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
import { AccountReady, AccountSetup } from './embedded-accounts';
import {
  CONFIGURE_PATH,
  DASHBOARD_PATH,
  USENET_PROVIDERS_PATH,
  activeDesktopPlayer,
  desktopShortcut,
  publishDesktopShell,
  typingIn,
  type BackendMode as Mode,
  type BackendState,
} from '@/lib/embedded-shell';

const MODE_KEY = 'aiostreams-desktop-backend-mode';
const API_PATH_KEY = 'aiostreams-desktop-local-api-path';
/** The user chose to continue without an AIOStreams account for now. */
const ACCOUNT_SKIP_KEY = 'aiostreams-desktop-account-skipped';
const CLOSE_PANEL_EVENT = 'aiostreams-desktop-close-panel';

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
      t`To connect to another server, choose Remote server in Settings, Local server.`
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

/** Only paths of the local server's own dashboard and configuration open in the panel. */
function panelPath(path: string): string {
  return path.startsWith('/dashboard') || path.startsWith('/stremio/')
    ? path
    : DASHBOARD_PATH;
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
  const [apiPath, setApiPath] = React.useState(() => {
    const saved = storage.get<string>(API_PATH_KEY);
    return saved &&
      (saved === '/jellyfin' || saved.startsWith('/jellyfin/')) &&
      !saved.includes('?') &&
      !saved.includes('#')
      ? saved
      : '/jellyfin';
  });
  const local = mode === 'local' && ready;
  /** The dashboard or configuration path open over the client, if any. */
  const [panel, setPanel] = React.useState<string | null>(null);
  const panelRef = React.useRef<string | null>(null);
  panelRef.current = panel;
  const pausedForPanel = React.useRef(false);
  const returnFocus = React.useRef<HTMLElement | null>(null);
  /** Remounts the client after configuration changes when nothing plays. */
  const [sessionKey, setSessionKey] = React.useState(0);
  const accounts = state.accounts ?? [];
  const [managingAccounts, setManagingAccounts] = React.useState(false);
  const [skippedAccount, setSkippedAccount] = React.useState(
    () => storage.get<boolean>(ACCOUNT_SKIP_KEY) === true
  );
  const [credentialShown, setCredentialShown] = React.useState(false);

  React.useEffect(() => {
    setEmbeddedOrigin(origin);
    return () => setEmbeddedOrigin(null);
  }, [origin]);

  const openServer = React.useCallback(
    (path: string = DASHBOARD_PATH) => {
      if (!local) return;
      if (panelRef.current === null) {
        returnFocus.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        // Pause through the player's own controller; the player stays mounted.
        const player = activeDesktopPlayer();
        if (player && !player.state.paused) {
          player.setPaused(true);
          pausedForPanel.current = true;
        }
      }
      setPanel(panelPath(path));
    },
    [local]
  );

  const closePanel = React.useCallback(() => {
    if (panelRef.current === null) return;
    setPanel(null);
    const player = activeDesktopPlayer();
    if (pausedForPanel.current && player) {
      toast(t`Paused while the server dashboard was open`, {
        action: {
          label: t`Resume`,
          onClick: () => activeDesktopPlayer()?.setPaused(false),
        },
      });
    }
    pausedForPanel.current = false;
    // Configuration changes show in the library: reload it when nothing
    // plays, otherwise only refresh its data so the player keeps going.
    if (playbackNow()) void queryClient.invalidateQueries();
    else setSessionKey((key) => key + 1);
    const focus = returnFocus.current;
    returnFocus.current = null;
    requestAnimationFrame(() => {
      if (focus?.isConnected) focus.focus();
    });
  }, [queryClient]);

  // The local server went away (restart, failure, remote mode): no panel.
  React.useEffect(() => {
    if (!local && panelRef.current !== null) closePanel();
  }, [local, closePanel]);

  React.useEffect(
    () =>
      onOpenConfiguration((url) => {
        const parsed = new URL(url);
        openServer(parsed.pathname + parsed.search + parsed.hash);
      }),
    [openServer]
  );

  // "Library" in the dashboard and configuration sidebars closes the panel.
  React.useEffect(() => {
    window.addEventListener(CLOSE_PANEL_EVENT, closePanel);
    return () => window.removeEventListener(CLOSE_PANEL_EVENT, closePanel);
  }, [closePanel]);

  const onKey = React.useCallback(
    (event: KeyboardEvent, inPanel: boolean) => {
      if (event.key === 'Escape' && panelRef.current !== null) {
        // Inside the dashboard, Escape first closes its own dialogs.
        const target = event.target as Node | null;
        const doc = target?.ownerDocument ?? document;
        if (inPanel && doc.querySelector('[role="dialog"], [role="alertdialog"]'))
          return;
        // Stop here: the player beneath would treat Escape as "leave".
        event.preventDefault();
        event.stopPropagation();
        closePanel();
        return;
      }
      const path = desktopShortcut(event);
      if (!path || typingIn(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      openServer(path);
    },
    [closePanel, openServer]
  );
  React.useEffect(() => {
    const handle = (event: KeyboardEvent) => onKey(event, false);
    window.addEventListener('keydown', handle, true);
    return () => window.removeEventListener('keydown', handle, true);
  }, [onKey]);

  const chooseMode = React.useCallback(
    (next: Mode) => {
      if (next === mode) return;
      setPanel(null);
      appBridge()?.send({ type: 'player-stop' });
      appBridge()?.send({ type: 'player-stop', external: true });
      navigate(to.home, { replace: true });
      queryClient.clear();
      storage.set(MODE_KEY, next);
      // The native shell chooses its trusted page origin from the persisted mode.
      // storage.set synchronously snapshots it before this status request.
      appBridge()?.send({ type: 'backend-status' });
      setMode(next);
    },
    [mode, queryClient]
  );
  const restart = React.useCallback(
    () => appBridge()?.send({ type: 'backend-restart' }),
    []
  );

  React.useEffect(() => {
    publishDesktopShell({
      state,
      mode,
      local,
      origin,
      openServer,
      restart,
      chooseMode,
      manageAccounts: () => setManagingAccounts(true),
      readDiagnostics: () => requestDiagnostics(origin),
    });
  }, [state, mode, local, origin, openServer, restart, chooseMode]);
  React.useEffect(() => () => publishDesktopShell(null), []);

  const finishAccountSetup = () => {
    appBridge()?.send({ type: 'backend-accounts-ack' });
    setCredentialShown(true);
  };
  const base = `${origin}${apiPath}`;

  return (
    <>
      <SplashEnd />
      {local && (
        <LocalLinks
          base={base}
          onBrowse={closePanel}
          onServer={(path) => {
            if (path !== '/jellyfin' && !path.startsWith('/jellyfin/')) return;
            storage.set(API_PATH_KEY, path);
            setApiPath(path);
            queryClient.clear();
            closePanel();
          }}
        />
      )}
      {mode === 'remote' ? (
        remote
      ) : ready ? (
        <React.Fragment key={sessionKey}>
          {browse(base, () => chooseMode('remote'))}
        </React.Fragment>
      ) : (
        <StartupScreen
          state={state}
          onRestart={restart}
          onUseRemote={() => chooseMode('remote')}
        />
      )}
      {local && panel !== null && (
        <ServerPanel
          src={`${origin}${panel}`}
          onKey={(event) => onKey(event, true)}
        />
      )}
      {local && state.newCredential && !credentialShown ? (
        <AccountReady
          credential={state.newCredential}
          accounts={accounts}
          onOpenProviders={() => {
            finishAccountSetup();
            openServer(USENET_PROVIDERS_PATH);
          }}
          onOpenConfiguration={() => {
            finishAccountSetup();
            openServer(CONFIGURE_PATH);
          }}
          onBrowse={finishAccountSetup}
        />
      ) : local &&
        !state.accountsError &&
        (managingAccounts || (accounts.length === 0 && !skippedAccount)) ? (
        <AccountSetup
          accounts={managingAccounts ? accounts : []}
          onCancel={
            managingAccounts ? () => setManagingAccounts(false) : undefined
          }
          onSkip={
            managingAccounts
              ? undefined
              : () => {
                  storage.set(ACCOUNT_SKIP_KEY, true);
                  setSkippedAccount(true);
                }
          }
          onUseRemote={
            managingAccounts ? undefined : () => chooseMode('remote')
          }
        />
      ) : null}
    </>
  );
}

/**
 * Upstream's own dashboard and configuration, over the client so a playing
 * title keeps its player. Their sidebars' "Library" entry closes it.
 */
function ServerPanel({
  src,
  onKey,
}: {
  src: string;
  onKey(event: KeyboardEvent): void;
}) {
  const frame = React.useRef<HTMLIFrameElement>(null);
  const [failed, setFailed] = React.useState(false);
  const latestKey = React.useRef(onKey);
  latestKey.current = onKey;
  React.useEffect(() => frame.current?.focus(), []);
  const loaded = () => {
    const win = frame.current?.contentWindow;
    try {
      // Same origin: Escape and the shortcuts work while the panel has focus.
      win?.addEventListener('keydown', (event) => latestKey.current(event), true);
      // An error answer (JSON, plain text) is not the dashboard page.
      setFailed(win?.document.contentType !== 'text/html');
    } catch {
      setFailed(true);
    }
  };
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t`Server dashboard`}
      className="fixed inset-0 z-[70] flex flex-col bg-[#101014] pt-10"
    >
      {failed && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 border-b border-white/10 px-4 py-2 text-sm text-amber-200"
        >
          <span>
            <Trans>The server dashboard did not load.</Trans>
          </span>
          <Button size="sm" intent="gray-outline" onClick={() => frame.current?.contentWindow?.location.reload()}>
            <Trans>Try again</Trans>
          </Button>
          <Button
            size="sm"
            intent="gray-outline"
            onClick={() => window.dispatchEvent(new CustomEvent(CLOSE_PANEL_EVENT))}
          >
            <Trans>Back to library</Trans>
          </Button>
        </div>
      )}
      <iframe
        ref={frame}
        title={t`Server dashboard`}
        src={src}
        onLoad={loaded}
        className="min-h-0 w-full flex-1 border-0 bg-[#101014]"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}

/** Before the local server is ready, or when it stopped. */
function StartupScreen({
  state,
  onRestart,
  onUseRemote,
}: {
  state: BackendState;
  onRestart(): void;
  onUseRemote(): void;
}) {
  const [since] = React.useState(() => Date.now());
  const [now, setNow] = React.useState(since);
  React.useEffect(() => {
    if (state.state !== 'starting') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.state]);
  const seconds = Math.floor((now - since) / 1000);
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return (
    <main className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-5 bg-[#101014] p-8 text-center text-white">
      <p className="text-sm font-medium uppercase tracking-widest text-gray-400">
        <Trans>AIOStreams Integrated</Trans>
      </p>
      <h1 className="text-3xl font-semibold">{statusLabel(state.state)}</h1>
      <p role={state.state === 'failed' ? 'alert' : 'status'} className="max-w-xl text-gray-300">
        {state.message}
      </p>
      {state.state === 'starting' && (
        <p className="font-mono text-sm text-gray-400" aria-hidden>
          {elapsed}
        </p>
      )}
      {state.state === 'starting' && seconds >= 45 && (
        <p className="max-w-xl text-sm text-gray-400">
          <Trans>The first start can take a few minutes while the server downloads its data. Later starts are faster.</Trans>
        </p>
      )}
      <div className="flex flex-wrap justify-center gap-3">
        {state.state !== 'starting' && (
          <Button intent="white" onClick={onRestart}>
            <Trans>Restart backend</Trans>
          </Button>
        )}
        <Button intent="gray-outline" onClick={openLogs}>
          <Trans>Open logs</Trans>
        </Button>
        {state.state !== 'starting' && (
          <Button intent="gray-outline" onClick={onUseRemote}>
            <Trans>Use a remote server instead</Trans>
          </Button>
        )}
      </div>
    </main>
  );
}
