#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist/updater-macos
app="dist/updater-macos/DICO Updater.app/Contents"
mkdir -p "$app/MacOS"
swiftc -module-cache-path "${TMPDIR:-/tmp}/dico-updater-build-cache" -O -target arm64-apple-macosx12.0 updater/Core.swift updater/main.swift -o dist/updater-macos/arm64
swiftc -module-cache-path "${TMPDIR:-/tmp}/dico-updater-build-cache" -O -target x86_64-apple-macosx12.0 updater/Core.swift updater/main.swift -o dist/updater-macos/x86_64
lipo -create dist/updater-macos/arm64 dist/updater-macos/x86_64 -output "$app/MacOS/dico-updater"
cat > "$app/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>dico-updater</string><key>CFBundleIdentifier</key><string>com.dico.updater.installer</string><key>CFBundleName</key><string>DICO Updater</string><key>CFBundleVersion</key><string>1</string><key>CFBundlePackageType</key><string>APPL</string><key>LSMinimumSystemVersion</key><string>12.0</string><key>NSHighResolutionCapable</key><true/></dict></plist>
PLIST
# Remove Finder packaging metadata from our generated app only. Quarantine and
# platform protections are never changed by the installer or updater.
xattr -dr com.apple.FinderInfo "dist/updater-macos/DICO Updater.app" 2>/dev/null || true
codesign --force --sign - "dist/updater-macos/DICO Updater.app"
cp updater/SETUP.md dist/updater-macos/SETUP.md
# Only the app and its guide enter the distributable, never intermediate binaries.
python3 - <<'PY'
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
root=Path('dist/updater-macos')
with ZipFile('dist/dico-updater-macos.zip','w',ZIP_DEFLATED) as z:
 for p in (root/'DICO Updater.app').rglob('*'):
  if p.is_file(): z.write(p,p.relative_to(root))
 z.write(root/'SETUP.md','SETUP.md')
PY
