#!/usr/bin/env bash
# iOS Simulator <-> Web interop (nightly.yml ios-web-interop, docs/TESTING_AND_CI.md §2.4).
# Runs on the macOS runner with the native backend and Caddy serving the Web app on http://localhost:8080, the app and
# UI tests built for testing (build-for-testing) and the simulator booted ($SIM_UDID).
#   1. Web -> iOS: the Playwright spec creates a session with a 64 MB fixture and writes its code and SHA-256 to
#      $INTEROP_DIR/web-session.json; this script passes them to InteropUITests/testReceivesFromTheWeb.
#   2. iOS -> Web: InteropUITests/testSendsToTheWeb prints "SA-INTEROP code=… sha256=… name=…"; this script starts the
#      Playwright receiver with those values.
# Both sides check the file's SHA-256. Exit status is non-zero if either direction fails.
set -euo pipefail
cd "$(dirname "$0")/.."
export INTEROP_DIR="${INTEROP_DIR:-$PWD/web/test-results/interop}"
rm -rf "$INTEROP_DIR" && mkdir -p "$INTEROP_DIR"
: "${SIM_UDID:?the booted simulator}"
pw() { pnpm --filter @share-anywhere/web exec playwright test e2e/nightly/android-interop.spec.ts --project=chromium-desktop --retries=0 --trace retain-on-failure "$@"; }
xctest() {
  # $1: test method; the rest: extra environment for the test runner (TEST_RUNNER_ prefix is stripped by xcodebuild).
  local name=$1
  shift
  env "$@" TEST_RUNNER_BACKEND_URL=http://127.0.0.1:8080 xcodebuild test-without-building -project ios/ShareAnywhere.xcodeproj \
    -scheme ShareAnywhere -destination "id=$SIM_UDID" -derivedDataPath ios/build/DerivedData \
    -resultBundlePath "$INTEROP_DIR/$name.xcresult" -only-testing "ShareAnywhereUITests/InteropUITests/$name" 2>&1 |
    tee "$INTEROP_DIR/$name.log" | grep -E "Test Case|error:|SA-INTEROP|\*\* TEST" || true
  grep -q "\*\* TEST EXECUTE SUCCEEDED \*\*" "$INTEROP_DIR/$name.log"
}
status=0

# The first test-without-building on a fresh simulator spends minutes installing the app and the UI-test runner. Do
# that now with a short test, so the Web sender's code (10-minute join window) is not spent waiting for it.
echo "== warm-up"
TEST_RUNNER_BACKEND_URL=http://127.0.0.1:8080 xcodebuild test-without-building -project ios/ShareAnywhere.xcodeproj \
  -scheme ShareAnywhere -destination "id=$SIM_UDID" -derivedDataPath ios/build/DerivedData \
  -resultBundlePath "$INTEROP_DIR/warm-up.xcresult" \
  -only-testing "ShareAnywhereUITests/GuestLaunchUITests/testFreshInstallGoesFromWelcomeToTransferWithoutSignIn" \
  > "$INTEROP_DIR/warm-up.log" 2>&1 || echo "warm-up failed (see warm-up.log); continuing"

echo "== Web -> iOS"
INTEROP_ROLE=web-sender pw > "$INTEROP_DIR/web-sender.log" 2>&1 &
web=$!
for _ in $(seq 1 120); do [ -s "$INTEROP_DIR/web-session.json" ] && break; sleep 2; done
if [ -s "$INTEROP_DIR/web-session.json" ]; then
  code=$(node -p "require('$INTEROP_DIR/web-session.json').code")
  sha=$(node -p "require('$INTEROP_DIR/web-session.json').sha256")
  xctest testReceivesFromTheWeb TEST_RUNNER_INTEROP_CODE="$code" TEST_RUNNER_INTEROP_SHA256="$sha" || status=1
else
  echo "the Web sender never created a session"; status=1
fi
wait "$web" || status=1
cat "$INTEROP_DIR/web-sender.log"

echo "== iOS -> Web"
xctest testSendsToTheWeb > "$INTEROP_DIR/ios-sender.out" 2>&1 &
ios=$!
line=""
for _ in $(seq 1 240); do
  line=$(grep -o 'SA-INTEROP code=[0-9]* sha256=[0-9a-f]* name=[^ ]*' "$INTEROP_DIR/testSendsToTheWeb.log" 2>/dev/null | tail -1 || true)
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
  echo "the iOS sender never printed its session"; status=1
fi
wait "$ios" || status=1
cat "$INTEROP_DIR/ios-sender.out"
exit $status
