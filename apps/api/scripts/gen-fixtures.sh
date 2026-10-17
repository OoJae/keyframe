#!/bin/sh
# Regenerates test/fixtures/*.m4v: tiny, deterministic, faststart H.264 clips at the Instant output sizes.
# (.m4v because the repo ignores *.mp4.)
set -eu
cd "$(dirname "$0")/../test/fixtures"
gen() { # name size seconds
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i "color=c=0x101010:s=$2:r=30:d=$3" \
    -c:v libx264 -preset ultrafast -crf 51 -pix_fmt yuv420p -g 300 -movflags +faststart \
    -fflags +bitexact -flags:v +bitexact -map_metadata -1 -f mp4 "$1.m4v"
}
gen launch-6s-9x16 1080x1920 6
gen countdown-8s-9x16 1080x1920 8
gen probe-2s-9x16 1080x1920 2
gen studio-10s-9x16 1080x1920 10
shasum -a 256 ./*.m4v
