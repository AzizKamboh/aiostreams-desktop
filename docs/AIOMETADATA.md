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

## Continue watching across devices

The app's server is private to this computer, so other devices cannot share
its Continue watching directly. A tracker (Simkl, MDBList, AniList,
MyAnimeList or PublicMetaDB) can be the shared place instead, through
AIOMetadata:

1. In **Configure AIOMetadata**, open **Watch tracking**. Turn on
   **Jellyfin apps** under *You watch on*, connect a service under
   *And it's sent to*, and save.
2. Add AIOMetadata to your AIOStreams configuration as a **Custom** addon (see
   above), if you have not yet.
3. In Settings → Local server → **Watch progress**, turn on **Sync watch
   progress with trackers**. The local server restarts.

What you play here is then sent to AIOMetadata, which records it with the
tracker. What you watched elsewhere with the same tracker (another computer,
Stremio, phone apps) comes back into Continue watching and Next up. Reading back
works without the switch; the switch only controls sending. It is AIOStreams'
`WATCH_STATE_REPORT_ENABLED`, off by default in this app, and controls every
addon that asks for playback reports, not only AIOMetadata.


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
| Admin key (DPAPI), if set | `...\aiometadata\admin-key.protected` |
| Port | `...\aiometadata\port` |

Both AIOMetadata and Redis listen on `127.0.0.1` only; nothing is reachable
from your network. Redis requires a random password that changes at every
start and is removed from disk once Redis has read it. Child output is never
copied to the app's log; only fixed, classified messages are.

AIOMetadata contacts the metadata services you configure (TMDB, TVDB, MAL,
AniList, Fanart.tv, MDBList and so on) and downloads public ID-mapping datasets
on first start, which can take a few minutes.

### Admin key (`ADMIN_KEY`)

At first start, after the AIOStreams account, the app asks for AIOMetadata's
admin key: the key AIOMetadata's dashboard (`http://127.0.0.1:3232/dashboard`)
asks for. **Generate** makes a strong one; copy it somewhere safe. The app keeps
it with Windows DPAPI (`...\aiometadata\admin-key.protected`) and passes it to
AIOMetadata as `ADMIN_KEY` at every start. **Skip for now** leaves the dashboard
closed; catalogs and metadata work either way. Set or change it any time in
Settings → Local server → AIOMetadata → **Admin key**.

### Other environment variables

AIOMetadata's other environment variables go in a `.env` file, the same file a
Docker install uses:

```text
%LOCALAPPDATA%\AIOStreams Integrated\aiometadata\state\.env
```

```ini
# Server-wide fallback keys, used when a configuration has none of its own
TMDB_API_KEY=...
```

Save it, then **Restart AIOMetadata** in Settings → Local server. The full list
is AIOMetadata's [`.env.example`](https://github.com/cedya77/aiometadata/blob/dev/.env.example).
The app loads the file before AIOMetadata starts.

Some values are always set by the app and win over the file: `PORT`,
`HOST_NAME`, `DATABASE_URI`, `REDIS_URL`, `IMAGE_PROXY_SIGNING_SECRET`,
`NODE_ENV`, and `ADMIN_KEY` once you have set one in the app. Background cache warming, which is meant for shared servers, is off
by default (`ENABLE_CACHE_WARMING`, `CACHE_WARMUP_ON_STARTUP`,
`MAL_WARMUP_ENABLED`, `TMDB_POPULAR_WARMING_ENABLED`). Setting any of those
four in the file turns it back on.

The file is plain text in your user folder, readable by programs running as
you. Treat it like the keys it holds.

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

New AIOMetadata releases are picked up automatically: the daily *Upstream
Sync* opens a pull request that updates the pin ([UPSTREAM-SYNC.md](UPSTREAM-SYNC.md#aiometadata)).
By hand:

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
