# Integrated desktop attribution and source

AIOStreams and its desktop client are copyright their upstream contributors,
led by Viren070. Original source: https://github.com/Viren070/AIOStreams.
This integrated variant is a modification of that project, licensed under
**AGPL-3.0-only**. The full license is shipped as `LICENSE`; the exact modified
application source and build scripts are shipped in
`source/aiostreams-integrated-source.tar.gz` and beside the installer.

The upstream client notices are preserved as `THIRD-PARTY-UPSTREAM.md`.
The runtime includes:

| Component | License / notices | Corresponding upstream source |
| --- | --- | --- |
| Node.js 24.18.1 | MIT and bundled third-party notices in `licenses/NODE-LICENSE` | https://nodejs.org/dist/v24.18.1/node-v24.18.1.tar.xz |
| Backend npm dependencies | `third-party-node-packages.json` and `licenses/npm/` include package metadata and supplied license/notice files | Package repositories and exact versions are recorded in that manifest and the source archive's `pnpm-lock.yaml` |
| libmpv and linked FFmpeg/media libraries | GPL-3.0 as described by upstream; bundled license texts in `licenses/mpv/` | https://github.com/AIOStreams/libs, release pinned in `packages/desktop/libs.pin`; that repository pins the library sources and patches |
| ffprobe 8.1.3, minimal build | LGPL-2.1-or-later; `licenses/ffmpeg/`; source tar included under `source/ffmpeg-8.1.3.tar.xz` | https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz; exact configure flags in `scripts/desktop/build-ffprobe.sh` |
| AIOMetadata 4.2.1 (cedya77) | AGPL-3.0-or-later core and FSL-1.1-ALv2 feature modules; `licenses/aiometadata/` (`LICENSING.md`, `NOTICE`, `THIRD_PARTY_NOTICES.txt`, `TRADEMARKS.md`); npm dependency notices in `aiometadata/app/node_modules` | `source/aiometadata-4.2.1-source.tar.gz`, from commit `bf7f520c` of https://github.com/cedya77/aiometadata |
| Redis 8.10.3 server | Used under AGPLv3 (Redis 8 is offered under RSALv2, SSPLv1 or AGPLv3); `licenses/redis/` | `source/redis-8.10.3.tar.gz` (https://download.redis.io/releases/redis-8.10.3.tar.gz); build flags in `scripts/desktop/build-redis.sh` |
| MSYS2 runtime (`msys-2.0.dll`) for Redis | LGPL-3.0-or-later with the Cygwin linking exception; `licenses/redis/msys2-runtime/` | https://github.com/msys2/msys2-runtime, the version installed by the build's MSYS2 |
| Vulkan loader | Apache-2.0; `vulkan/VulkanRT-License.txt` | https://github.com/KhronosGroup/Vulkan-Loader |
| Rust dependencies | Generated complete license text in `third-party-licenses.html` and metadata in `third-party-licenses.json` | Crates and exact versions in the source archive's `packages/desktop/Cargo.lock` |
| Bundled browser JavaScript | Bundler-generated `.LICENSE.txt` notices alongside frontend assets | Source archive, package metadata and `pnpm-lock.yaml` |
| Microsoft Edge WebView2 fixed runtime | Microsoft proprietary redistribution terms; original runtime files retained in `webview2/` | https://developer.microsoft.com/microsoft-edge/webview2/ and https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution |
| Microsoft Visual C++ runtime DLLs | Microsoft Visual Studio redistributable terms; app-local DLLs copied from the build toolchain's official redist directory | https://learn.microsoft.com/visualstudio/releases/2022/redistribution |

The included ffprobe build disables GPL-only/nonfree features and compiles
only the selected demuxers/parsers/decoders required by the server. libmpv's
separate GPL build retains upstream's licensing and source requirements.
Do not present this application as an official upstream release.

Redistributors must preserve notices and provide the corresponding source
required by each copyleft dependency, including the exact libmpv/FFmpeg
patches and library builds identified by the pinned upstream build recipes.
An application source archive alone does not replace those dependency source
obligations. No installer has been licensed or signed on behalf of Microsoft
or upstream contributors by these scripts.
