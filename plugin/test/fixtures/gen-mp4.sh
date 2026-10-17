#!/bin/sh
# Regenerates test/fixtures/sting-1080x1920-6s.m4v (needs ffmpeg + ffprobe). A 6 s, 30 fps, 1080x1920 H.264
# faststart file shaped like an Instant 9:16 master; bitexact flags keep it reproducible. .m4v = same ISO-BMFF
# container (the repo .gitignore excludes *.mp4 renders).
set -eu
cd "$(dirname "$0")"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "color=c=0x0b0b10:size=1080x1920:rate=30" -t 6 \
  -c:v libx264 -preset ultrafast -crf 51 -g 180 -pix_fmt yuv420p -map_metadata -1 \
  -fflags +bitexact -flags:v +bitexact -movflags +faststart -f mp4 sting-1080x1920-6s.m4v
ffprobe -v error -select_streams v:0 -show_entries format=duration:stream=width,height -of json sting-1080x1920-6s.m4v \
  > sting-1080x1920-6s.ffprobe.json
ls -l sting-1080x1920-6s.m4v
