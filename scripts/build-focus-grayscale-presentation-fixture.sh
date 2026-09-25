#!/bin/sh
set -eu

# Builds a synthetic AppKit window with the production grayscale renderer and
# CAMetalLayer. Open the printed .app to compare its four quadrants visually.
# No Screen Recording permission or ScreenCaptureKit stream is needed.
script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository=$(CDPATH= cd -- "${script_directory}/.." && pwd)
architecture=$(uname -m)
case "${architecture}" in
  arm64|x86_64) ;;
  *) echo "Unsupported architecture: ${architecture}" >&2; exit 1 ;;
esac

application_path=${1:-"${TMPDIR:-/tmp}/FocusGrayscalePresentationFixture.app"}
mkdir -p "${application_path}/Contents/MacOS"
cat > "${application_path}/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>io.github.cliffordfajardo.focus-grayscale-fixture</string>
  <key>CFBundleName</key><string>FocusGrayscalePresentationFixture</string>
  <key>CFBundleExecutable</key><string>FocusGrayscalePresentationFixture</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
EOF

xcrun swiftc \
  -target "${architecture}-apple-macos14.0" \
  -swift-version 6 \
  -o "${application_path}/Contents/MacOS/FocusGrayscalePresentationFixture" \
  "${repository}/native/bridge/FocusGrayscale.swift" \
  "${repository}/native/bridge/tests/FocusGrayscaleTestShims.swift" \
  "${repository}/native/bridge/tests/FocusGrayscalePresentationFixture.swift" \
  -framework AppKit \
  -framework ScreenCaptureKit \
  -framework CoreImage \
  -framework CoreMedia \
  -framework CoreVideo \
  -framework Metal \
  -framework QuartzCore

echo "${application_path}"
