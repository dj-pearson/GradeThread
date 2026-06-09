#!/usr/bin/env bash
# Post-processes fastlane snapshot output into exact App Store Connect
# screenshot sizes (US-197). macOS only (uses sips).
#
#   in:  ios/fastlane/screenshots/en-US/*.png   (snapshot output)
#   out: ios/fastlane/screenshots-appstore/
#          iphone-6.9/  — 1320x2868 native iPhone 16 Pro Max captures (copied)
#          iphone-6.5/  — 1284x2778 derived (scale-to-fill + center-crop,
#                         ~0.5% edge loss, no distortion)
#          ipad-13/     — 2064x2752 / 2752x2064 native iPad Pro 13" (copied)
#
# Any capture with an unrecognized size is reported and skipped so a new
# device in the Snapfile can't silently ship a wrong-sized screenshot.
set -euo pipefail

SRC="${1:-$(dirname "$0")/../fastlane/screenshots}"
OUT="${2:-$(dirname "$0")/../fastlane/screenshots-appstore}"

if ! command -v sips >/dev/null; then
  echo "error: sips not found — this script runs on macOS" >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT/iphone-6.9" "$OUT/iphone-6.5" "$OUT/ipad-13"

# 6.5" derivation: scale so width hits the target, then center-crop the
# few rows of height overshoot. sips -c takes HEIGHT then WIDTH.
derive_65() { # $1=src $2=dst
  cp "$1" "$2"
  sips --resampleWidth 1284 "$2" >/dev/null
  sips -c 2778 1284 "$2" >/dev/null
}

shopt -s nullglob
count=0 skipped=0
for png in "$SRC"/en-US/*.png "$SRC"/*.png; do
  name=$(basename "$png")
  w=$(sips -g pixelWidth "$png" | awk '/pixelWidth/ {print $2}')
  h=$(sips -g pixelHeight "$png" | awk '/pixelHeight/ {print $2}')
  case "${w}x${h}" in
    1320x2868|2868x1320)            # iPhone 16 Pro Max — native 6.9" slot
      cp "$png" "$OUT/iphone-6.9/$name"
      if [ "$w" = "1320" ]; then     # derive portrait 6.5"; landscape iPhone shots are not submitted
        derive_65 "$png" "$OUT/iphone-6.5/$name"
      fi
      ;;
    1290x2796|2796x1290)            # iPhone 16/15 Pro Max class — also accepted in the big slot
      cp "$png" "$OUT/iphone-6.9/$name"
      if [ "$w" = "1290" ]; then
        derive_65 "$png" "$OUT/iphone-6.5/$name"
      fi
      ;;
    1284x2778|2778x1284|1242x2688|2688x1242)  # already exact 6.5" sizes
      cp "$png" "$OUT/iphone-6.5/$name"
      ;;
    2064x2752|2752x2064|2048x2732|2732x2048)  # iPad 13" slot — native
      cp "$png" "$OUT/ipad-13/$name"
      ;;
    *)
      echo "skip: $name is ${w}x${h} — not a recognized App Store size" >&2
      skipped=$((skipped + 1))
      continue
      ;;
  esac
  count=$((count + 1))
done

echo "Processed $count screenshot(s), skipped $skipped."
for d in iphone-6.9 iphone-6.5 ipad-13; do
  n=$(ls "$OUT/$d" 2>/dev/null | wc -l | tr -d ' ')
  echo "  $d: $n file(s)"
done
