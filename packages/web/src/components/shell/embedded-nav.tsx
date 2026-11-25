/**
 * AIOStreams Integrated: native entries for the local server, placed by small
 * hooks in upstream's sidebar/menus and Settings. Each renders
 * nothing outside the integrated desktop app or in remote-server mode.
 */
import { t } from '@lingui/core/macro';
import { LuLibrary, LuServer, LuSlidersHorizontal } from 'react-icons/lu';
import type { SidebarItem } from '@aiostreams/ui/shared/sidebar';
import { CONFIGURE_PATH, useDesktopShell } from '@/lib/embedded-shell';

/** "AIOStreams Configuration" and "AIOStreams Dashboard", beside Settings in every navigation layout. */
export function useDesktopNavItems(): SidebarItem[] {
  const shell = useDesktopShell();
  if (!shell?.local) return [];
  return [
    {
      id: 'aiostreams-configure',
      name: t`AIOStreams Configuration`,
      iconType: LuSlidersHorizontal,
      onClick: () => shell.openServer(CONFIGURE_PATH),
    },
    {
      id: 'aiostreams-server',
      name: t`AIOStreams Dashboard`,
      iconType: LuServer,
      onClick: () => shell.openServer(),
    },
  ];
}

/**
 * "AIOMetadata", in the desktop sidebar only (not the menus, rails or tabs):
 * opens AIOMetadata's configuration page in the system browser, where its own
 * pages belong (they never get the app bridge). Shown once AIOMetadata is ready.
 */
export function useDesktopSidebarItems(): SidebarItem[] {
  const status = useDesktopShell()?.state.aiometadata;
  if (status?.state !== 'ready' || !status.url) return [];
  const url = `${status.url}/configure`;
  return [
    {
      id: 'aiometadata',
      name: t`AIOMetadata`,
      iconType: LuLibrary,
      // A new window is handed to the system browser by the native shell.
      onClick: () => window.open(url, '_blank', 'noopener'),
    },
  ];
}

/** Beside "Change server" on every sign-in screen, before any configuration exists. */
export function useDesktopSignInLinks(): { label: string; onClick: () => void }[] {
  const shell = useDesktopShell();
  if (shell?.mode === 'remote')
    return [
      {
        label: t`Use the server on this computer`,
        onClick: () => shell.chooseMode('local'),
      },
    ];
  if (!shell?.local) return [];
  return [
    {
      label: t`Create or edit a configuration`,
      onClick: () => shell.openServer(CONFIGURE_PATH),
    },
    { label: t`AIOStreams Dashboard`, onClick: () => shell.openServer() },
  ];
}
