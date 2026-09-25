#!/bin/sh
set -eu
script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# Production edge/card presentation with capture-free test doubles. Run the printed app's
# executable for per-assertion output and a nonzero exit status on failure.
repository=$(CDPATH= cd -- "${script_directory}/.." && pwd)
fixtures="${repository}/native/bridge/tests"
application_path=${1:-"${TMPDIR:-/tmp}/FocusEdgePresentationFixture.app"}
build="${application_path}/Contents/Frameworks"
mkdir -p "${build}" "${application_path}/Contents/MacOS"
cat > "${application_path}/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>io.github.cliffordfajardo.focus-edge-fixture</string>
<key>CFBundleName</key><string>FocusEdgePresentationFixture</string>
<key>CFBundleExecutable</key><string>FocusEdgePresentationFixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
architecture=$(uname -m)
xcrun swiftc -target "${architecture}-apple-macos14.0" -emit-library -emit-module \
  -module-name ActivityCore -emit-module-path "${build}/ActivityCore.swiftmodule" \
  "${repository}"/native/collector/Sources/ActivityCore/*.swift \
  -Xlinker -install_name -Xlinker @rpath/libActivityCore.dylib -o "${build}/libActivityCore.dylib"
xcrun swiftc -target "${architecture}-apple-macos14.0" -I "${build}" -L "${build}" -lActivityCore \
  -Xlinker -rpath -Xlinker @executable_path/../Frameworks \
  "${repository}/native/bridge/FocusOverlay.swift" "${repository}/native/bridge/FocusEdge.swift" \
  "${fixtures}/FocusEdgeTestShims.swift" "${fixtures}/FocusEdgeFixtureSupport.swift" "${fixtures}/FocusEdgePresentationFixture.swift" \
  -framework AppKit -framework ApplicationServices -framework QuartzCore \
  -o "${application_path}/Contents/MacOS/FocusEdgePresentationFixture"
printf '%s\n' "${application_path}"
