#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Run in MSYS2 MINGW64. No compiler or shell is shipped to the end user.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
build="$repo/.embedded-build/ffmpeg"
mkdir -p "$build"
archive="$repo/.embedded-build/ffmpeg-8.1.3.tar.xz"
if [[ ! -f "$archive" ]]; then
  curl --fail --location --retry 3 https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz -o "$archive"
fi
echo "7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3  $archive" | sha256sum -c -
tar -xf "$archive" -C "$build" --strip-components=1
cd "$build"
./configure \
  --target-os=mingw32 --arch=x86_64 --cc=/mingw64/bin/gcc \
  --disable-everything --disable-autodetect --disable-doc --disable-debug \
  --disable-shared --enable-static --extra-ldflags=-static \
  --disable-programs --enable-ffprobe \
  --disable-avdevice --disable-avfilter --disable-swscale --disable-swresample \
  --disable-x86asm --enable-zlib \
  --enable-protocol=file,http,tcp \
  --enable-demuxer=asf,avi,flv,matroska,mov,mpegps,mpegts,ogg \
  --enable-parser=aac,aac_latm,ac3,av1,dca,dvbsub,dvdsub,flac,h264,hevc,mlp,mpeg4video,mpegaudio,mpegvideo,opus,vc1,vorbis,vp8,vp9 \
  --enable-decoder=aac,aac_latm,ac3,alac,dca,eac3,flac,mlp,mp2,mp3,opus,truehd,vorbis,pcm_bluray,pcm_dvd,pcm_s16le,pcm_s24le,h264,hevc,mpeg2video,mpeg4,vc1,vp8,vp9,ass,ssa,subrip,srt,webvtt,movtext,pgssub,dvdsub,dvbsub
make -j"$(nproc)" ffprobe.exe
strip ffprobe.exe
./ffprobe.exe -version
