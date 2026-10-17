#!/bin/sh
# Regenerates the committed MP4 fixtures used by test/mp4.test.ts (needs ffmpeg + ffprobe on PATH).
# Fixtures use the .m4v extension (same ISO-BMFF container) because the repo .gitignore excludes *.mp4 renders.
# Tiny on purpose: 64x36, 1 s, 30 fps H.264 (+ silent AAC to exercise multi-track moov parsing).
set -eu
cd "$(dirname "$0")/../test/fixtures"
common="-hide_banner -loglevel error -y -f lavfi -i testsrc=size=64x36:rate=30 -f lavfi -i anullsrc=r=48000:cl=mono \
  -t 1 -map 0:v -map 1:a -c:v libx264 -preset ultrafast -crf 40 -pix_fmt yuv420p -c:a aac -b:a 16k \
  -map_metadata -1 -fflags +bitexact -flags:v +bitexact -flags:a +bitexact -f mp4"
# shellcheck disable=SC2086
ffmpeg $common -movflags +faststart faststart.m4v
# shellcheck disable=SC2086
ffmpeg $common moov-at-end.m4v
ffprobe -v error -select_streams v:0 -show_entries format=duration:stream=width,height -of json faststart.m4v > faststart.ffprobe.json
ls -l faststart.m4v moov-at-end.m4v
