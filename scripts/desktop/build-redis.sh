#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Builds the Redis server bundled for AIOMetadata (which needs Redis 8 for
# per-field hash expiry: HSETEX/HTTL). Redis has no Windows port, so it is
# compiled against the MSYS2 POSIX runtime: run this in MSYS2 with MSYSTEM=MSYS
# (not MINGW64). Packages: gcc make pkgconf curl tar.
# No compiler or shell is shipped to the end user; only redis-server.exe and the
# MSYS2 runtime DLLs it links, which are listed in THIRD-PARTY.md.
# Keep the version and checksum in step with scripts/desktop/runtime-pins.json.
set -euo pipefail
version=8.10.3
sha256=edde778f6bdee7581e42fc139ca9e07e2822212092f7501f99989656e3629d02
if [[ "${MSYSTEM:-}" != MSYS ]]; then
  echo "Run in the MSYS2 MSYS environment (MSYSTEM=MSYS), found '${MSYSTEM:-none}'." >&2
  exit 1
fi
repo="$(cd "$(dirname "$0")/../.." && pwd)"
build="$repo/.embedded-build/redis"
out="$build/dist"
archive="$repo/.embedded-build/redis-$version.tar.gz"
mkdir -p "$repo/.embedded-build"
if [[ ! -f "$archive" ]]; then
  curl --fail --location --retry 3 "https://download.redis.io/releases/redis-$version.tar.gz" -o "$archive"
fi
echo "$sha256  $archive" | sha256sum -c -
rm -rf "$build"
mkdir -p "$build/src" "$build/include" "$out/licenses"
tar -xzf "$archive" -C "$build/src" --strip-components=1

# Cygwin/MSYS2 declares dladdr()/Dl_info (used by Redis's crash reporter) only
# under __GNU_VISIBLE. Shadow the header for this build instead of editing the
# system copy.
sed 's/__GNU_VISIBLE/1/' /usr/include/dlfcn.h > "$build/include/dlfcn.h"

cd "$build/src"
# Only the server: no TLS (loopback only), libc malloc (jemalloc does not build
# on this runtime), no optional modules.
make -j"$(nproc)" -C src redis-server \
  BUILD_TLS=no MALLOC=libc USE_SYSTEMD=no \
  CFLAGS="-I$build/include" OPTIMIZATION=-O2
strip src/redis-server.exe
./src/redis-server.exe --version

cp src/redis-server.exe "$out/"
# The MSYS2 runtime DLLs the server links (msys-2.0.dll and any others).
ldd src/redis-server.exe | awk '$3 ~ /^\/usr\/bin\// { print $3 }' | sort -u | while read -r dll; do
  cp "$dll" "$out/"
done
ls "$out"/msys-2.0.dll >/dev/null
# Redis 8 is offered under RSALv2, SSPLv1 or AGPLv3; this AGPL-licensed app
# uses it under AGPLv3, whose full text is in LICENSE.txt.
cp LICENSE.txt REDISCONTRIBUTIONS.txt "$out/licenses/"
if [[ -d /usr/share/licenses/msys2-runtime ]]; then
  cp -r /usr/share/licenses/msys2-runtime "$out/licenses/msys2-runtime"
fi
echo "Redis $version for the bundled AIOMetadata is in $out"
