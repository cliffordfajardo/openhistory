#!/bin/sh
set -eu

# Builds a small app around the production timer bar: the real panels, the real placement helper
# and the real C entry point, with only the appearance lookup stood in for. Open the printed .app
# to watch the bar shrink and to read one ok/FAIL line per presentation check; it exits non-zero if
# any check failed. No Screen Recording permission and no other app are needed.
script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository=$(CDPATH= cd -- "${script_directory}/.." && pwd)
architecture=$(uname -m)
case "${architecture}" in
  arm64|x86_64) ;;
  *) echo "Unsupported architecture: ${architecture}" >&2; exit 1 ;;
esac

application_path=${1:-"${TMPDIR:-/tmp}/TimerBarPresentationFixture.app"}
mkdir -p "${application_path}/Contents/MacOS"
cat > "${application_path}/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>io.github.cliffordfajardo.focus-timer-bar-fixture</string>
  <key>CFBundleName</key><string>TimerBarPresentationFixture</string>
  <key>CFBundleExecutable</key><string>TimerBarPresentationFixture</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
EOF

xcrun swiftc \
  -target "${architecture}-apple-macos14.0" \
  -o "${application_path}/Contents/MacOS/TimerBarPresentationFixture" \
  "${repository}/native/collector/Sources/ActivityCore/TimerBarPlacement.swift" \
  "${repository}/native/collector/Sources/ActivityCore/FocusProgressColor.swift" \
  "${repository}/native/bridge/TimerBar.swift" \
  "${repository}/native/bridge/tests/TimerBarTestShims.swift" \
  "${repository}/native/bridge/tests/TimerBarPresentationFixture.swift" \
  -framework AppKit \
  -framework QuartzCore

echo "${application_path}"
