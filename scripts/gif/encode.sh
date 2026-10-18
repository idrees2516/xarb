#!/usr/bin/env bash
# Encode a frames dir into an optimized GIF (two-pass palette).
# usage: encode.sh <frames_dir> <out.gif> [fps] [scale] [max_mb]
set -e
DIR="$1"; OUT="$2"; FPS="${3:-10}"; SCALE="${4:-1280x800}"; MAXMB="${5:-24}"

enc() {
  ffmpeg -nostdin -hide_banner -loglevel error -y \
    -framerate "$FPS" -i "$DIR/f_%05d.jpg" \
    -vf "scale=$SCALE:flags=lanczos,palettegen=stats_mode=diff:max_colors=160" \
    -update 1 -frames:v 1 "$DIR/palette.png" < /dev/null
  ffmpeg -nostdin -hide_banner -loglevel error -y \
    -framerate "$FPS" -i "$DIR/f_%05d.jpg" -i "$DIR/palette.png" \
    -lavfi "scale=$SCALE:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
    -loop 0 "$OUT" < /dev/null
}
enc
SZ=$(du -m "$OUT" | cut -f1)
if [ "$SZ" -gt "$MAXMB" ]; then
  echo "  $SZ MB > $MAXMB MB — re-encoding at fps 8 ..."
  FPS=8; enc
  SZ=$(du -m "$OUT" | cut -f1)
fi
if [ "$SZ" -gt "$MAXMB" ]; then
  echo "  $SZ MB > $MAXMB MB — re-encoding at 1120x700 ..."
  SCALE=1120x700; enc
  SZ=$(du -m "$OUT" | cut -f1)
fi
echo "OK $(basename "$OUT") ${SZ}MB · $(ls "$DIR" | grep -c 'f_.*\.jpg') frames @ ${FPS}fps $SCALE"
