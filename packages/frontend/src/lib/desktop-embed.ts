/**
 * AIOStreams Integrated: the dashboard and configuration pages open as a panel
 * over the desktop app's own library. These helpers add a "Browse" entry that
 * closes that panel (upstream already has a Usenet "Library" page). Outside the integrated desktop app they return nothing,
 * so the hosted dashboard is unchanged.
 */
import { BiMoviePlay } from 'react-icons/bi';

const CLOSE_EVENT = 'aiostreams-desktop-close-panel';

/** True only inside the integrated desktop app's server panel. */
export function inDesktopPanel(): boolean {
  try {
    if (window.parent === window) return false;
    const parent = window.parent as Window & {
      aiostreamsApp?: { backend?: boolean };
    };
    return parent.location.origin === window.location.origin &&
      parent.aiostreamsApp?.backend === true;
  } catch {
    // A cross-origin parent is not the desktop app.
    return false;
  }
}

export function closeDesktopPanel(): void {
  // postMessage crosses frames reliably; the app checks the sender's origin.
  window.parent.postMessage({ type: CLOSE_EVENT }, window.location.origin);
}

/** Footer entries for the dashboard and configuration sidebars. */
export function desktopFooterItems() {
  if (!inDesktopPanel()) return [];
  return [
    { name: 'Browse', iconType: BiMoviePlay, onClick: closeDesktopPanel },
  ];
}
