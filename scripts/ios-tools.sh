#!/usr/bin/env bash
# Installs the pinned iOS lint and project tools into ./.tools/bin (CI and local macOS), verifying each download's
# SHA-256 (docs/ADR/0022-ios-project-and-core-package.md). Usage: scripts/ios-tools.sh; then export PATH="$PWD/.tools/bin:$PATH".
set -euo pipefail
cd "$(dirname "$0")/.."
BIN=.tools/bin
mkdir -p "$BIN"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

fetch() { # name url sha256
  curl -sSfL -o "$TMP/$1.zip" "$2"
  echo "$3  $TMP/$1.zip" | shasum -a 256 -c - >/dev/null
  unzip -qo "$TMP/$1.zip" -d "$TMP/$1"
}

fetch swiftlint https://github.com/realm/SwiftLint/releases/download/0.57.1/portable_swiftlint.zip \
  aa2e0f8f8272545e5593ebedd7872db51132fcec4ead76d001bbe17af69c7ae5
install -m 755 "$TMP/swiftlint/swiftlint" "$BIN/swiftlint"

fetch swiftformat https://github.com/nicklockwood/SwiftFormat/releases/download/0.55.3/swiftformat.zip \
  c5f18ff5392e92fac927dfdaf66017009a56fae0f6f55691ebb878483f521d22
install -m 755 "$TMP/swiftformat/swiftformat" "$BIN/swiftformat"

fetch xcodegen https://github.com/yonaskolb/XcodeGen/releases/download/2.42.0/xcodegen.zip \
  a760b4bf97460341316a2c00d8c87b2946c6c2729eb57e9a72abb3ef7bc0ef82
rm -rf .tools/xcodegen && mkdir -p .tools && cp -R "$TMP/xcodegen/xcodegen" .tools/xcodegen
ln -sf ../xcodegen/bin/xcodegen "$BIN/xcodegen"

"$BIN/swiftlint" version
"$BIN/swiftformat" --version
"$BIN/xcodegen" --version
