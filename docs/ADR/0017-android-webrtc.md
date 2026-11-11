# ADR 0017: WebRTC library for Android

Status: Accepted (Phase 6, milestone 6.1, 2026-11-11); used from milestone 6.3

## Context

The Android transfer engine (milestone 6.3) speaks the Phase 3 wire protocol over WebRTC DataChannels (`docs/TRANSFER_PROTOCOL.md`). `docs/ARCHITECTURE.md` §2 leaves the choice between `io.getstream:stream-webrtc-android` and an `org.webrtc` artifact to an ADR. Requirements: DataChannel with `bufferedAmount` and the low-threshold callback (backpressure), `getStats()` for the selected candidate pair (route recording, Phase 8 route strategy), TURN over UDP/TCP/TLS, current security fixes, Maven Central distribution with pinned versions, and minSdk 26.

## Decision

Use **`io.getstream:stream-webrtc-android`**, pinned to one release in `gradle/libs.versions.toml` when milestone 6.3 adds it (no dependency is added in 6.1, so the 6.1 APK carries no native WebRTC code). Only the core artifact is used; the Compose UI and Stream SDK extras are not.

## Reasons

- Google's prebuilt `org.webrtc:google-webrtc` stopped at `1.0.32006` (2020) on JCenter, which is read-only; it lacks years of libwebrtc security fixes and current DataChannel and stats behaviour.
- `stream-webrtc-android` is a maintained build of the upstream libwebrtc Java/JNI API (`org.webrtc.*` packages, so code and documentation carry over), published to Maven Central with regular milestone updates, under permissive licences (upstream libwebrtc is BSD-3-Clause; milestone 6.3 records the packaging licence with the pinned version), with native libraries for the phone ABIs and `x86_64` (the CI emulator image is `x86_64`; 6.3 verifies the ABI list of the pinned version).
- Building libwebrtc ourselves would need a separate toolchain and CI time far beyond this project's budget.

## Consequences

- The native libraries add several megabytes per ABI (6.3 measures the APK). Release builds ship as an app bundle (per-ABI delivery); debug APKs include every ABI.
- Upstream updates arrive through Stream's release cadence; milestone 6.3 records the pinned version and the libwebrtc milestone it is built from, and dependency review in CI covers it.
- If the artifact stops being maintained, the `org.webrtc.*` API keeps a switch to another build of libwebrtc mechanical.
