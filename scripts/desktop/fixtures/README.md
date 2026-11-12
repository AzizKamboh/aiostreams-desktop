# Local playback fixture

`test-pattern.mp4` is a one-second generated blue frame with a 440 Hz sine tone.
It contains no third-party media. The generated fixture is dedicated to the
public domain under CC0-1.0.

Regenerate with FFmpeg (only needed by a developer changing the fixture):

```sh
ffmpeg -f lavfi -i color=c=0x2266aa:s=128x72:r=12:d=1 \
  -f lavfi -i sine=frequency=440:duration=1 \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac \
  -movflags +faststart -shortest -y test-pattern.mp4
```

The smoke test serves this file from loopback, obtains a URL through the real
AIOStreams proxy API, and verifies complete and ranged streaming. If supplied,
`--ffprobe <path>` reads the stream through that URL and `--ffmpeg <path>` fully
decodes both its video and audio. These are backend media checks; they do not
claim to test the native Windows player or WebView2 rendering. FFmpeg is optional
test tooling and is not required to run the desktop application.
