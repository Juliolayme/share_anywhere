#!/usr/bin/env bash
# Encrypted Clipboard Sync, Web <-> Android emulator (nightly.yml clipboard-cross-client, docs/TESTING_AND_CI.md §2.2).
# Runs inside the emulator step with the CI stack up and the debug and test APKs built (-Pbackend=http://10.0.2.2:8080).
# The Playwright spec and ClipboardInteropTest exchange values through CLIP_INTEROP_DIR (Web -> script) and logcat tag
# SA-CLIP (Android -> script). Exit status is non-zero if either side fails.
set -euo pipefail
cd "$(dirname "$0")/.."
export CLIP_INTEROP_DIR="${CLIP_INTEROP_DIR:-$PWD/web/test-results/clipboard-interop}"
rm -rf "$CLIP_INTEROP_DIR" && mkdir -p "$CLIP_INTEROP_DIR"
RUNNER=app.shareanywhere.test/app.shareanywhere.SettledMediaRunner  # waits for MediaProvider to finish the pm clear
adb install -r -g android/app/build/outputs/apk/debug/app-debug.apk >/dev/null
adb install -r -g android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk >/dev/null
adb shell pm clear app.shareanywhere >/dev/null
adb logcat -c
status=0

pnpm --filter @share-anywhere/web exec playwright test e2e/nightly/clipboard-cross-client.spec.ts --project=chromium-desktop \
  --retries=0 --trace retain-on-failure > "$CLIP_INTEROP_DIR/web.log" 2>&1 &
web=$!
for _ in $(seq 1 150); do [ -s "$CLIP_INTEROP_DIR/clip-account.json" ] && break; sleep 2; done
if [ ! -s "$CLIP_INTEROP_DIR/clip-account.json" ]; then
  echo "the Web never created the account"; status=1
else
  email=$(node -p "require('$CLIP_INTEROP_DIR/clip-account.json').email")
  password=$(node -p "require('$CLIP_INTEROP_DIR/clip-account.json').password")
  marker=$(node -p "require('$CLIP_INTEROP_DIR/clip-account.json').webMarker")
  adb shell am instrument -w -e backend http://10.0.2.2:8080 -e clipboard interop -e email "$email" -e password "$password" \
    -e webMarker "$marker" -e class app.shareanywhere.ClipboardInteropTest "$RUNNER" > "$CLIP_INTEROP_DIR/android.log" 2>&1 &
  android=$!
  # Relay the Android pairing code and marker from logcat to the Web.
  for _ in $(seq 1 300); do
    pair=$(adb logcat -d -s SA-CLIP:I | grep -o 'pair=[^ ]*' | tail -1 | sed 's/^pair=//' || true)
    [ -n "$pair" ] && [ ! -s "$CLIP_INTEROP_DIR/android-pairing.txt" ] && echo "$pair" > "$CLIP_INTEROP_DIR/android-pairing.txt"
    m=$(adb logcat -d -s SA-CLIP:I | grep -o 'marker=.*$' | tail -1 | sed 's/^marker=//; s/\r$//' || true)
    if [ -n "$m" ]; then echo "$m" > "$CLIP_INTEROP_DIR/android-marker.txt"; break; fi
    kill -0 "$android" 2>/dev/null || break
    sleep 2
  done
  wait "$android" || true
  cat "$CLIP_INTEROP_DIR/android.log"
  grep -q "^OK (1 test)" "$CLIP_INTEROP_DIR/android.log" || {
    status=1
    adb logcat -d | grep -E "SA-CLIP|SA-TRANSFER|AndroidRuntime|TestRunner: (failed|java)" | tail -100 || true
  }
fi
wait "$web" || status=1
cat "$CLIP_INTEROP_DIR/web.log"
exit $status
