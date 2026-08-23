#!/usr/bin/env bash
# build-app.sh - compile StarlinkBar and wrap it in a real .app bundle.
#
# The bundle is what launchd runs and what the Desktop icon points at, so there
# is exactly one copy of the binary on the machine. LSUIElement keeps it out of
# the Dock: it lives in the menu bar, and a click on the Desktop icon opens the
# dashboard via applicationShouldHandleReopen.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="${1:-/Applications/Starlink Monitor.app}"

echo "building binary..."
swiftc -O "$HERE/StarlinkBar.swift" -o "$HERE/StarlinkBar"

if [ ! -f "$HERE/AppIcon.icns" ]; then
  echo "building icon..."
  python3 "$HERE/make-icon.py" "$HERE/icon.iconset"
  iconutil -c icns "$HERE/icon.iconset" -o "$HERE/AppIcon.icns"
fi

echo "assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$HERE/StarlinkBar" "$APP/Contents/MacOS/StarlinkBar"
cp "$HERE/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Starlink Monitor</string>
  <key>CFBundleDisplayName</key><string>Starlink Monitor</string>
  <!-- MUST differ from the launchd label com.8gi.starlink.menubar. When the
       two strings match, LaunchServices has the bundle registered under that
       identifier and launchd refuses the job with "Bootstrap failed: 5". -->
  <key>CFBundleIdentifier</key><string>com.8gi.starlink.desktop</string>
  <key>CFBundleExecutable</key><string>StarlinkBar</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# Ad-hoc sign so Gatekeeper does not quarantine a locally built bundle.
codesign --force --deep --sign - "$APP" 2>/dev/null || echo "  (codesign skipped)"
# Nudge Launch Services so the icon appears immediately instead of after a relaunch.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$APP" 2>/dev/null || true

echo "built $APP"
