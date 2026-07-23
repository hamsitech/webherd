#!/usr/bin/env bash
# Build ~/Applications/webherd.app — a stub bundle whose only jobs are giving
# the background services a name + icon in System Settings (via
# AssociatedBundleIdentifiers) and opening the dashboard when launched.
# The icon is Herd's app icon with a globe badge, composed locally from the
# installed Herd.app (requires python3 + Pillow for the badge; falls back to
# the plain Herd icon without it).
set -euo pipefail

APP="/Applications/webherd.app"
TMP="$(mktemp -d)"

sips -s format png /Applications/Herd.app/Contents/Resources/AppIcon.icns \
  --out "$TMP/base.png" --resampleWidth 1024 >/dev/null

if python3 -c 'import PIL' 2>/dev/null; then
  python3 - "$TMP" <<'PY'
import math
import sys

from PIL import Image, ImageDraw

tmp = sys.argv[1]
base = Image.open(f"{tmp}/base.png").convert("RGBA")
badge = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
d = ImageDraw.Draw(badge)
cx, cy, R = 790, 790, 175
d.ellipse((cx - R - 18, cy - R - 18, cx + R + 18, cy + R + 18), fill=(255, 255, 255, 255))
blue = (10, 102, 194, 255)
d.ellipse((cx - R, cy - R, cx + R, cy + R), fill=(235, 244, 252, 255), outline=blue, width=16)
for frac in (-0.5, 0.0, 0.5):
    y = cy + frac * R
    half = R * math.cos(math.asin(abs(frac)))
    d.line((cx - half, y, cx + half, y), fill=blue, width=12)
d.line((cx, cy - R, cx, cy + R), fill=blue, width=12)
for w in (0.45, 0.8):
    d.ellipse((cx - R * w, cy - R, cx + R * w, cy + R), outline=blue, width=12)
Image.alpha_composite(base, badge).save(f"{tmp}/icon.png")
PY
else
  cp "$TMP/base.png" "$TMP/icon.png"
fi

mkdir -p "$TMP/webherd.iconset"
for sz in 16 32 128 256 512; do
  sips -z "$sz" "$sz" "$TMP/icon.png" --out "$TMP/webherd.iconset/icon_${sz}x${sz}.png" >/dev/null
  sips -z "$((sz * 2))" "$((sz * 2))" "$TMP/icon.png" --out "$TMP/webherd.iconset/icon_${sz}x${sz}@2x.png" >/dev/null
done
iconutil -c icns "$TMP/webherd.iconset" -o "$TMP/webherd.icns"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$TMP/webherd.icns" "$APP/Contents/Resources/webherd.icns"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "$here/Info.plist" "$APP/Contents/Info.plist"
cat > "$APP/Contents/MacOS/webherd" <<'LAUNCH'
#!/bin/sh
exec open http://webherd.test
LAUNCH
chmod +x "$APP/Contents/MacOS/webherd"
codesign -s - --force "$APP" 2>/dev/null || true
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
echo "installed $APP"
