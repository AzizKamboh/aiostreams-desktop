# Where the integration touches upstream code

Goal: keep upstream AIOStreams files as close to their original bytes as
possible, so that merging a new upstream release mostly means accepting it.
Integration logic lives in files upstream does not have; upstream files get
small, commented hooks that call into them.

Baseline: upstream `desktop-v0.24.0`, commit `76a5d6da`. Regenerate the list
below with:

```sh
git fetch --no-tags https://github.com/Viren070/AIOStreams.git 76a5d6da6d1babf885c7f65a2e19bbd55401a26d
git diff --stat 76a5d6da HEAD -- packages
```

## Integration-owned files (upstream has none of these)

| File | Purpose |
| --- | --- |
| `packages/core/src/utils/desktop-env.ts` | Desktop env defaults; merges the internal `desktop` account with the user's `AIOSTREAMS_AUTH`; log redaction of desktop secrets |
| `packages/server/src/desktop.ts` | Private access boundary (token, Host/Origin checks), ready event, stdin shutdown |
| `packages/server/src/desktop-routes.ts` | `/__desktop/*` routes: session bootstrap, client files, source download, account list and Usenet account check |
| `packages/web/src/components/shell/embedded-desktop.tsx` | Embedded shell UI: status, Server settings, Diagnostics, local/remote switch |
| `packages/web/src/components/shell/embedded-accounts.tsx` | Account setup, "account ready" step, account management |
| `packages/web/src/components/shell/embedded-nav.tsx` | "Server dashboard" sidebar/menu item, player button, sign-in links |
| `packages/web/src/components/shell/embedded-local-server.tsx` | Settings → Local server |
| `packages/web/src/lib/embedded-shell.ts` | Shell state shared with those hooks; active player registry; shortcuts |
| `packages/frontend/src/lib/desktop-embed.ts` | "Browse" entry in the dashboard/configuration sidebars, only inside the app |
| `packages/web/src/lib/embedded-*.ts` | Local origin handling, settings persistence across ports, account rules |
| `packages/desktop/app/src/backend.rs`, `backend/*.rs`, `embedded.rs` | Node supervisor, DPAPI storage, accounts, Job Object |
| `scripts/desktop/*`, `.github/workflows/embedded-desktop.yml` | Build, packaging, tests |

## Hooks in upstream files

| Upstream file | Change | Why |
| --- | --- | --- |
| `core/src/utils/env.ts` | 1 import | Run `desktop-env.ts` before the environment is parsed |
| `core/src/logging/redact.ts` | 1 import, 2 lines | Always redact desktop secrets; never log sensitive data in desktop mode |
| `core/src/utils/http.ts` | 1 line | Compare origins, not string prefixes, before sending the internal secret (security fix worth offering upstream) |
| `server/src/app.ts` | 1 import, 1 call | `installDesktop()` before upstream middleware; 2 `sendFile` options for install paths containing a dot-folder |
| `server/src/server.ts` | 3 calls | Loopback-only listen, ready event, WebSocket gate, stdin shutdown |
| `server/src/routes/api/proxy.ts` | ~18 lines | Never forward desktop cookies/auth or the internal secret to media providers; never relay a provider's Set-Cookie or CSP onto the private origin |
| `server/src/routes/stremio/configure.ts` | 1 option | `dotfiles: 'allow'` for install paths |
| `web/src/app.tsx` | ~15 lines | Mount the embedded shell in the desktop build |
| `web/src/lib/hosts/shell/bridge.ts` | types only | Backend-state and account messages |
| `web/src/components/shell/layout.tsx` | 1 hook, footer lists | "Server dashboard" next to Settings in every navigation layout |
| `web/src/app/settings/page.tsx` | 1 section entry | Settings → Local server |
| `web/src/app/sign-in/page.tsx` | 1 hook in `LinkRow` | Configuration/dashboard links (or "use this computer's server") on sign-in screens |
| `web/src/features/player/options.tsx` | 1 element | Server dashboard button in the player controls |
| `web/src/features/remote/remote-target.tsx` | 1 hook | Registers the active player so the panel can pause and resume it |
| `frontend/src/routes/dashboard-layout.tsx`, `frontend/src/app/configure/main-sidebar.tsx` | 1 import, 1 spread each | "Browse" footer entry inside the desktop app |
| `web/src/lib/jellyfin/session.tsx`, `settings/index.ts`, `storage.ts`, `app/settings/account.tsx`, `components/media/no-catalogs.tsx` | 1–9 lines each | Local sign-in, Discord presence default off, storage change event, open configuration in-app |
| `web/rsbuild.config.ts`, `web/src/env.d.ts` | 1 constant | Server version shown in Diagnostics |
| `web/src/locales/en-GB.po`, `messages.pot` | appended entries | Source text for new UI strings |
| `desktop/app/src/main.rs`, `shell/tao_shell.rs`, `platform/windows.rs`, `bridge.js`, `updates.rs`, `Cargo.toml` | small | Start the backend, trust its origin, app identity, integrated version, updater off |
| `desktop/core/src/downloads.rs`, `logs.rs` | small | Authorise local download URLs; log redaction |

Upstream files keep their original byte-order marks and formatting so diffs show
only real changes.

## Upstream behaviour the integration depends on

Check these when merging a new upstream release:

- `AIOSTREAMS_AUTH` / `AIOSTREAMS_AUTH_PERMISSIONS` syntax and permission names
  (`core/src/utils/env.ts`, `permissions.ts`). The account rules are mirrored
  in `web/src/lib/embedded-accounts.ts` and `desktop/app/src/backend/accounts.rs`.
- `checkAuthToken(credential, Permission.Service)` as the built-in Usenet
  service's authorisation (`core/src/debrid/aiostreams.ts`).
- Dashboard routes `/dashboard`, `/dashboard/usenet/providers` and
  `/stremio/configure` (`frontend/src/router.tsx`), opened in the panel.
- `footerItems` in the two frontend sidebars, `footerItems`/`menuItems` in
  `web/src/components/shell/layout.tsx`, `LinkRow` on sign-in screens,
  `OptionButtons` in the player and `useRemotePlayer` receiving the controller.
- Player key bindings (`web/src/lib/input/actions.ts`): the integration's
  Ctrl+, shortcuts must not collide with new upstream ones.
- `setSessionCookie` and the `/api/v1/health` endpoint.
- The desktop bridge protocol between `desktop/app` and `web/src/lib/hosts/shell`.
