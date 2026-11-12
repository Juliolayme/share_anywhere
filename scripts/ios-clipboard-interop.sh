#!/usr/bin/env bash
# Encrypted Clipboard Sync, Web <-> iOS Simulator (nightly.yml ios-web-interop, docs/TESTING_AND_CI.md §2.2): the iOS
# half of clipboard-cross-client. Runs after the app and UI tests were built for testing, with the backend and Caddy up
# on http://localhost:8080 and the simulator booted ($SIM_UDID). The shared Playwright spec reads the new device's
# pairing code and marker from android-pairing.txt and android-marker.txt (names from the Android job); this script
# writes them from the "SA-CLIP" lines InteropUITests prints. Exit status is non-zero if either side fails.
set -euo pipefail
cd "$(dirname "$0")/.."
export CLIP_INTEROP_DIR="${CLIP_INTEROP_DIR:-$PWD/web/test-results/clipboard-interop}"
rm -rf "$CLIP_INTEROP_DIR" && mkdir -p "$CLIP_INTEROP_DIR"
: "${SIM_UDID:?the booted simulator}"
status=0

pnpm --filter @share-anywhere/web exec playwright test e2e/nightly/clipboard-cross-client.spec.ts --project=chromium-desktop \
  --retries=0 --trace retain-on-failure > "$CLIP_INTEROP_DIR/web.log" 2>&1 &
web=$!
for _ in $(seq 1 150); do [ -s "$CLIP_INTEROP_DIR/clip-account.json" ] && break; sleep 2; done
if [ ! -s "$CLIP_INTEROP_DIR/clip-account.json" ]; then
  echo "the Web never created the account"; status=1
else
  log="$CLIP_INTEROP_DIR/ios.log"
  TEST_RUNNER_BACKEND_URL=http://127.0.0.1:8080 \
    TEST_RUNNER_INTEROP_EMAIL=$(node -p "require('$CLIP_INTEROP_DIR/clip-account.json').email") \
    TEST_RUNNER_INTEROP_PASSWORD=$(node -p "require('$CLIP_INTEROP_DIR/clip-account.json').password") \
    TEST_RUNNER_INTEROP_WEB_MARKER=$(node -p "require('$CLIP_INTEROP_DIR/clip-account.json').webMarker") \
    xcodebuild test-without-building -project ios/ShareAnywhere.xcodeproj -scheme ShareAnywhere -destination "id=$SIM_UDID" \
    -derivedDataPath ios/build/DerivedData -resultBundlePath "$CLIP_INTEROP_DIR/clipboard.xcresult" \
    -only-testing ShareAnywhereUITests/InteropUITests/testExchangesClipboardItemsWithTheWeb > "$log" 2>&1 &
  ios=$!
  # Relay the pairing code and the iOS marker from the test output to the Web.
  for _ in $(seq 1 300); do
    pair=$(grep -o 'SA-CLIP pair=[^ ]*' "$log" 2>/dev/null | tail -1 | sed 's/^SA-CLIP pair=//' || true)
    [ -n "$pair" ] && [ ! -s "$CLIP_INTEROP_DIR/android-pairing.txt" ] && echo "$pair" > "$CLIP_INTEROP_DIR/android-pairing.txt"
    m=$(grep -o 'SA-CLIP marker=[^ ]*' "$log" 2>/dev/null | tail -1 | sed 's/^SA-CLIP marker=//' || true)
    if [ -n "$m" ]; then echo "$m" > "$CLIP_INTEROP_DIR/android-marker.txt"; break; fi
    kill -0 "$ios" 2>/dev/null || break
    sleep 2
  done
  wait "$ios" || true
  grep -E "Test Case|error:|SA-CLIP|\*\* TEST" "$log" || true
  grep -q "\*\* TEST EXECUTE SUCCEEDED \*\*" "$log" || status=1
fi
wait "$web" || status=1
cat "$CLIP_INTEROP_DIR/web.log"
exit $status
