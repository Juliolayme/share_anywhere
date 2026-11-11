# Android App Links for share links

Share links and QR codes point at `<SA_PUBLIC_URL>/j/<token>` (`docs/API.md` §2.2). The Android app declares an
intent filter for that origin (`android/app/src/main/AndroidManifest.xml`, host from the Gradle property
`publicUrl` for debug builds and `releasePublicUrl`, defaulting to `releaseBackend`, for release builds). Release builds set `android:autoVerify="true"`;
debug builds do not, because `localhost` and `10.0.2.2` cannot be verified.

## Serving `assetlinks.json`

1. Take the SHA-256 fingerprint of the certificate that signs the release APK or app bundle (for Play App Signing,
   the "App signing key certificate" fingerprint in Play Console), in the `AA:BB:…` form.
2. Set `SA_ANDROID_CERT_SHA256` in the environment of the Caddy service. `infra/caddy/Caddyfile` then answers
   `GET /.well-known/assetlinks.json` with the `delegate_permission/common.handle_all_urls` statement for package
   `app.shareanywhere`. Unset, the file is not served and links keep opening in the browser (the Web join page).
3. Check from outside: `curl -s https://<public host>/.well-known/assetlinks.json`, then on a device
   `adb shell pm verify-app-links --re-verify app.shareanywhere` and `adb shell pm get-app-links app.shareanywhere`
   (state `verified`).

## Inside the app

`MainActivity` accepts `ACTION_VIEW` intents only when the full origin (scheme, host, port) equals the build's public
URL and the path is `/j/<base64url token of 22–128 characters>`; the token goes only to `POST /v1/sessions/resolve-link`
on the configured backend. The link opens RX-3 (resolving) and then RX-4 (join preview) without Welcome in front of it.

## Status

The intent filter and the in-app handling are exercised on the CI emulator with an explicit intent
(`ReceiverJoinTest`). Domain verification is **untested** until a release build is signed and installed on a real
device against a public HTTPS origin.
