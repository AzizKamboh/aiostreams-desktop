/**
 * AIOStreams Integrated: native entries for the local server, placed by small
 * hooks in upstream's sidebar/menus, Settings and player controls. Each renders
 * nothing outside the integrated desktop app or in remote-server mode.
 */
import { t } from '@lingui/core/macro';
import { LuServer } from 'react-icons/lu';
import type { SidebarItem } from '@aiostreams/ui/shared/sidebar';
import { ControlButton } from '@/features/player/buttons';
import { CONFIGURE_PATH, useDesktopShell } from '@/lib/embedded-shell';

/** "Server dashboard", beside Settings in every navigation layout. */
export function useDesktopNavItems(): SidebarItem[] {
  const shell = useDesktopShell();
  if (!shell?.local) return [];
  return [
    {
      id: 'aiostreams-server',
      name: t`Server dashboard`,
      iconType: LuServer,
      onClick: () => shell.openServer(),
    },
  ];
}

/** In the player's own controls, so it shows and hides with them. */
export function DesktopServerButton() {
  const shell = useDesktopShell();
  if (!shell?.local) return null;
  return (
    <ControlButton
      name="aiostreams-server"
      label={t`Server dashboard`}
      onClick={() => shell.openServer()}
    >
      <LuServer />
    </ControlButton>
  );
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
    { label: t`Server dashboard`, onClick: () => shell.openServer() },
  ];
}
