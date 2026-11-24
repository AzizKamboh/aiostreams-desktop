# AIOMetadata in AIOStreams Integrated

The Windows app runs [AIOMetadata](https://github.com/cedya77/aiometadata)
(cedya77's metadata and catalog addon) on your computer, next to the
AIOStreams server, the way it already runs the AIOStreams server: no Docker,
no separate install. You configure AIOMetadata in your browser and add it to
AIOStreams as a **custom addon**.

AIOMetadata is a separate project. This build uses it unmodified and is not
endorsed by it; see *Licences* below.

## Using it

1. Open **Settings → Local server → AIOMetadata**. Once the status reads
   *AIOMetadata ready*, the address is `http://127.0.0.1:3232`.
2. Select **Configure AIOMetadata**. Its configuration page opens in your
   browser. Add your API keys (TMDB and others, as AIOMetadata asks), choose
   catalogs and providers, then save. AIOMetadata shows your install
   (manifest) URL, `http://127.0.0.1:3232/stremio/<your-uuid>/manifest.json`.
3. Select **AIOStreams addons** (the AIOStreams configuration), add a
   **Custom** addon and paste that manifest URL. Save the configuration.

AIOMetadata's catalogs, metadata and search then appear in the app like any
other addon's. The port stays the same between launches so the URL keeps
working. If another program already uses 3232, AIOMetadata picks another port
and the status says so; update the custom addon's URL in that case.

**Restart AIOMetadata** restarts only AIOMetadata (and its Redis); the
AIOStreams server and playback are not affected, and the reverse is also true.

## What runs

| Part | What | Where it comes from |
| --- | --- | --- |
| AIOMetadata | the release pinned in `scripts/desktop/runtime-pins.json` (`aiometadata`), built with its own `npm run build` / `build:backend`, on the bundled Node runtime | `scripts/desktop/stage-aiometadata.mjs` |
| Redis 8 | AIOMetadata requires Redis 8 (per-field hash expiry, `HSETEX`/`HTTL`). Redis has no Windows port, so it is compiled from the pinned source against the MSYS2 runtime | `scripts/desktop/build-redis.sh` |
| Preload | adapts AIOMetadata to a desktop process without changing it: listens on `127.0.0.1` only, keeps data in your user folder, stops cleanly when the app asks | `scripts/desktop/aiometadata/preload.cjs` |
| Supervisor | starts Redis then AIOMetadata, health-checks both, restarts once after a crash, stops both with the app (Windows Job Objects) | `packages/desktop/app/src/backend/aiometadata.rs` |

Installed files: `aiometadata\app`, `aiometadata\desktop`, `aiometadata\redis`
in the install folder. Only the packages AIOMetadata's server loads are
installed; its configuration page's libraries are already bundled into
`dist/client`.

## Data and privacy

| Data | Location |
| --- | --- |
| AIOMetadata database, ID-mapping and artwork caches | `%LOCALAPPDATA%\AIOStreams Integrated\aiometadata\state\addon\data` |
| Redis append-only file (sessions, Jellyfin state, cache) | `%LOCALAPPDATA%\AIOStreams Integrated\aiometadata\redis` |
| Image-URL signing secret (DPAPI) | `...\aiometadata\signing-secret.protected` |
| Port | `...\aiometadata\port` |

Both AIOMetadata and Redis listen on `127.0.0.1` only; nothing is reachable
from your network. Redis requires a random password that changes at every
start and is removed from disk once Redis has read it. Child output is never
copied to the app's log; only fixed, classified messages are.

AIOMetadata contacts the metadata services you configure (TMDB, TVDB, MAL,
AniList, Fanart.tv, MDBList and so on) and downloads public ID-mapping datasets
on first start, which can take a few minutes.

Background cache warming, meant for shared servers, is off. To change that or
set any other AIOMetadata environment variable (for example server-wide API
keys or `ADMIN_KEY` for its dashboard), create
`%LOCALAPPDATA%\AIOStreams Integrated\aiometadata\state\.env`
([reference](https://github.com/cedya77/aiometadata/blob/dev/.env.example)) and
restart AIOMetadata. The address, database and Redis settings are always the
app's own.

## Building

```sh
# MSYS2, MSYS environment (not MINGW64), in the repository root
MSYSTEM=MSYS bash scripts/desktop/build-redis.sh
```

`package-windows.ps1` then runs `stage-aiometadata.mjs` (git and npm on
`PATH`), and before packaging runs `scripts/desktop/aiometadata/smoke.mjs` and
the supervisor's lifecycle test against the staged files. To try the staged
copy from a development build, set `AIOMETADATA_DESKTOP_ROOT` to the staged
`aiometadata` folder.

### Updating AIOMetadata or Redis

- AIOMetadata: change `aiometadata.version`, `tag` and `commit` in
  `runtime-pins.json`. The stage script refuses a checkout whose commit or
  `package.json` version differs. Check its release notes for new required
  services or a new Redis requirement, and that `addon/lib/runtimePaths.js`
  still exists (the preload relies on it and fails loudly if it is gone).
- Redis: change `redis` in `runtime-pins.json` and the `version`/`sha256` at the
  top of `build-redis.sh` (official hashes: https://github.com/redis/redis-hashes).

## Licences

- **AIOMetadata**: AGPL-3.0-or-later core with FSL-1.1-ALv2 feature modules
  (see its `LICENSING.md`). Notices are in `licenses\aiometadata` and
  `aiometadata\app`; the exact source is `source\aiometadata-<version>-source.tar.gz`.
  "AIOMetadata" and its logo are cedya77's trademarks; this app only says it
  runs AIOMetadata.
- **Redis 8**: used under AGPLv3 (one of its three licence options); notices
  in `licenses\redis`, source in `source\redis-<version>.tar.gz`, build recipe
  in `scripts/desktop/build-redis.sh`.
- **MSYS2 runtime** (`msys-2.0.dll`, from Cygwin): LGPL-3.0-or-later with
  the Cygwin linking exception; notices in `licenses\redis\msys2-runtime`;
  source at https://github.com/msys2/msys2-runtime.
