# ADR 0019: QR codes on Android (generation and scanning)

Status: Accepted (Phase 6, milestone 6.2, 2026-11-11)

## Context

The Android app shows the join link as a QR code on the sender's session screen (TR-4) and scans the sender's QR code on Receive (RX-1). `docs/phases/PHASE_6_ANDROID.md` allows CameraX with ML Kit barcode scanning or ZXing. Requirements: no Google Play services dependency (the app must work on devices without them, and the debug APK must stay reproducible), works offline, pinned versions in the version catalog and lockfile, and a decoder that JVM unit tests can exercise without a device.

## Decision

- **Generation and decoding: ZXing `com.google.zxing:core` 3.5.3** (pure Java, Apache-2.0). The share panel encodes `join_url` at error-correction level H so the design's centre mark never hides data; codes are drawn dark-on-light in both themes so every scanner reads them.
- **Camera: CameraX 1.4.2** (`camera-camera2`, `camera-lifecycle`, `camera-view`): a `PreviewView` and an `ImageAnalysis` analyzer (keep-only-latest) that passes the luminance plane to ZXing on a background thread.
- The camera permission is asked just in time on the Scan tab, with denied ("Open settings") and unavailable (no back camera) states; code entry is always one tap away. `android.hardware.camera.any` is declared not required.
- Scanned text is accepted only when it is a link to this build's public origin (`<SA_PUBLIC_URL>/j/<base64url token>`, `linkTokenFrom`), as the Web does; nothing else is opened or fetched.

## Reasons

- ML Kit's bundled barcode model adds a few megabytes per ABI and its unbundled variant needs Play services; ZXing core is about 0.5 MB, has no native code, and decodes the same QR codes for this use (one code, held close).
- The same library on both ends lets JVM unit tests round-trip encode → render → decode, including the centre mark, inverted codes and row-stride padding (`QrTest`).

## Consequences

- Scanning works on the CI emulator only as "camera unavailable" (the emulator runs with `-camera-back none`); the scanner itself is **untested on a device** until milestone 6.5 or a real-device check. The decoder is covered by unit tests.
- ZXing core is in maintenance mode; QR decoding is stable, and swapping the analyzer for another decoder would not change the UI or the link validation.
