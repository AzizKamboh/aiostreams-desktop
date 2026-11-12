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
| `server/src/routes/api/proxy.ts` | ~10 lines | Never forward desktop cookies/auth or the internal secret to media providers |
| `server/src/routes/stremio/configure.ts` | 1 option | `dotfiles: 'allow'` for install paths |
| `web/src/app.tsx` | ~15 lines | Mount the embedded shell in the desktop build |
| `web/src/lib/hosts/shell/bridge.ts` | types only | Backend-state and account messages |
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
- Dashboard route `/dashboard/usenet/providers` (`frontend/src/router.tsx`),
  linked from the setup screen.
- `setSessionCookie` and the `/api/v1/health` endpoint.
- The desktop bridge protocol between `desktop/app` and `web/src/lib/hosts/shell`.
