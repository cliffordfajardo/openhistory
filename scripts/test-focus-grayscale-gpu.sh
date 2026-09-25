#!/bin/sh
set -eu

# Renders synthetic pixels through the production Swift GPU renderer. This test does not
# start the app, construct a ScreenCaptureKit stream, or request Screen Recording access.
# Exit 77 means no Metal device is available and should be treated as a test skip.
script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository=$(CDPATH= cd -- "${script_directory}/.." && pwd)
architecture=$(uname -m)
case "${architecture}" in
  arm64|x86_64) ;;
  *) echo "Unsupported architecture: ${architecture}" >&2; exit 1 ;;
esac

build_directory=$(mktemp -d "${TMPDIR:-/tmp}/focus-grayscale-gpu.XXXXXX")
trap 'rm -rf "${build_directory}"' EXIT HUP INT TERM

xcrun swiftc \
  -target "${architecture}-apple-macos14.0" \
  -swift-version 6 \
  -o "${build_directory}/focus-grayscale-gpu-test" \
  "${repository}/native/bridge/FocusGrayscale.swift" \
  "${repository}/native/bridge/tests/FocusGrayscaleTestShims.swift" \
  "${repository}/native/bridge/tests/FocusGrayscaleGPUHarness.swift" \
  -framework AppKit \
  -framework ScreenCaptureKit \
  -framework CoreImage \
  -framework CoreMedia \
  -framework CoreVideo \
  -framework Metal \
  -framework QuartzCore

"${build_directory}/focus-grayscale-gpu-test"
