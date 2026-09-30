#!/bin/zsh
# Builds "Site Showcase.app" (native window + logo) and installs it in /Applications.
# Re-run this if you move the project folder: the app remembers where the project lives.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -d node_modules ] || { npm install && npx playwright install chromium; }

BUILD="dist"
APP="$BUILD/Site Showcase.app"
rm -rf "$APP" "$BUILD/AppIcon.iconset"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$BUILD/AppIcon.iconset"

echo "→ Rendering icon"
node macos/render-icon.mjs "$BUILD/icon-1024.png"
for s in 16 32 128 256 512; do
  sips -z $s $s "$BUILD/icon-1024.png" --out "$BUILD/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$BUILD/icon-1024.png" --out "$BUILD/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$BUILD/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"
sips -z 256 256 "$BUILD/icon-1024.png" --out "$APP/Contents/Resources/logo.png" >/dev/null

echo "→ Compiling"
swiftc -O -o "$APP/Contents/MacOS/SiteShowcase" macos/SiteShowcase.swift -framework Cocoa -framework WebKit

cp macos/Info.plist "$APP/Contents/Info.plist"
plutil -replace SSProjectPath -string "$ROOT" "$APP/Contents/Info.plist"
codesign --force --deep --sign - "$APP" >/dev/null

DEST="/Applications"
[ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }
rm -rf "$DEST/Site Showcase.app"
cp -R "$APP" "$DEST/"
echo "✓ Installed $DEST/Site Showcase.app"
