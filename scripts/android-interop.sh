#!/usr/bin/env bash
# Android emulator <-> Web interop (nightly.yml android-web-interop, docs/TESTING_AND_CI.md §2.4).
# Runs inside the emulator step with the CI stack up and the debug and test APKs built (-Pbackend=http://10.0.2.2:8080).
#   1. Web -> Android: the Playwright spec creates a session with a 64 MB fixture and writes its code and SHA-256 to
#      $INTEROP_DIR/web-session.json; this script passes them to InteropTest#receivesFromTheWeb.
#   2. Android -> Web: InteropTest#sendsToTheWeb logs "SA-INTEROP code=… sha256=… name=…"; this script starts the
#      Playwright receiver with those values.
# Both sides check the file's SHA-256. Exit status is non-zero if either direction fails.
set -euo pipefail
cd "$(dirname "$0")/.."
export INTEROP_DIR="${INTEROP_DIR:-$PWD/web/test-results/interop}"
rm -rf "$INTEROP_DIR" && mkdir -p "$INTEROP_DIR"
RUNNER=app.shareanywhere.test/androidx.test.runner.AndroidJUnitRunner
APP=android/app/build/outputs/apk/debug/app-debug.apk
TEST_APK=android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb install -r -g "$APP" >/dev/null
adb install -r -g "$TEST_APK" >/dev/null
pw() { pnpm --filter @share-anywhere/web exec playwright test e2e/nightly/android-interop.spec.ts --project=chromium-desktop --retries=0 --trace retain-on-failure "$@"; }
instrument() {
  # am instrument exits 0 even when a test fails; the result block says OK only when every test passed.
  local out
  out=$(adb shell am instrument -w -e backend http://10.0.2.2:8080 -e class "app.shareanywhere.InteropTest#$1" "${@:2}" "$RUNNER" | tee /dev/stderr)
  grep -q "^OK (1 test)" <<<"$out"
}
status=0

echo "== Web -> Android"
INTEROP_ROLE=web-sender pw > "$INTEROP_DIR/web-sender.log" 2>&1 &
web=$!
for _ in $(seq 1 120); do [ -s "$INTEROP_DIR/web-session.json" ] && break; sleep 2; done
if [ -s "$INTEROP_DIR/web-session.json" ]; then
  code=$(node -p "require('$INTEROP_DIR/web-session.json').code")
  sha=$(node -p "require('$INTEROP_DIR/web-session.json').sha256")
  id=$(node -p "require('$INTEROP_DIR/web-session.json').id")
  adb shell pm clear app.shareanywhere >/dev/null
  instrument receivesFromTheWeb -e interop receive -e code "$code" -e sha256 "$sha" -e session "$id" || status=1
else
  echo "the Web sender never created a session"; status=1
fi
wait "$web" || status=1
cat "$INTEROP_DIR/web-sender.log"

echo "== Android -> Web"
adb shell pm clear app.shareanywhere >/dev/null
adb logcat -c
instrument sendsToTheWeb -e interop send > "$INTEROP_DIR/android-sender.log" 2>&1 &
android=$!
line=""
for _ in $(seq 1 120); do
  line=$(adb logcat -d -s SA-INTEROP:I | grep -o 'code=[0-9]* sha256=[0-9a-f]* name=[^ ]*' | tail -1 || true)
  [ -n "$line" ] && break
  sleep 2
done
if [ -n "$line" ]; then
  INTEROP_ROLE=web-receiver \
    INTEROP_CODE=$(sed 's/.*code=\([0-9]*\).*/\1/' <<<"$line") \
    INTEROP_SHA256=$(sed 's/.*sha256=\([0-9a-f]*\).*/\1/' <<<"$line") \
    INTEROP_NAME=$(sed 's/.*name=\([^ ]*\).*/\1/' <<<"$line") \
    pw || status=1
else
  echo "the Android sender never logged its session"; status=1
fi
wait "$android" || status=1
cat "$INTEROP_DIR/android-sender.log"
exit $status
