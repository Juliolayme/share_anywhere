# ADR 0026: WebRTC on iOS (StreamWebRTC)

Status: Accepted (Phase 7, milestone 7.3, 2026-11-12)

## Context

CLAUDE.md §5 asks for WebRTC through the `stream-webrtc-ios` SPM package or Google's `WebRTC` xcframework, decided in an ADR. The transport is a single ordered, reliable `sa-transfer/1` DataChannel (docs/TRANSFER_PROTOCOL.md); no audio or video. The dependency must come through Swift Package Manager only, pinned exactly, and build for the iOS simulator on the macOS runner.

## Decision

- **StreamWebRTC 145.25.0** from `https://github.com/GetStream/stream-video-swift-webrtc.git` (product `StreamWebRTC`), pinned with `exactVersion` in `ios/project.yml`. It is a binary target; SwiftPM checks the archive against the checksum in the package manifest (`aa8cbd50…9c57` for 145.25.0), so a changed archive fails the build. The xcframework carries device and simulator slices.
- **The app owns the adapter, the Core owns the logic.** `ShareAnywhereCore/SATransferRuntime` defines `PeerFactory`, `PeerLink` and `DataChannelLink`; the sender and receiver controllers, signaling, reporting and storage depend only on those protocols and are tested on Linux and macOS with in-memory peers. `ios/ShareAnywhere/Transfer/WebRTCPeer.swift` implements them with `RTCPeerConnectionFactory` (one per process, `RTCInitializeSSL()` once), unified plan, gather-once ICE, and the TURN credentials plus a `stun:` URI on the same host (as the Web and Android). The route (direct or relay) is read from the selected candidate pair in `RTCStatisticsReport`.
- **No media.** No camera or microphone tracks are created; the camera is used only by the QR scanner (AVFoundation), never by WebRTC.

## Alternatives considered

- **Google's prebuilt `WebRTC` xcframework.** Google no longer publishes official iOS builds; community repackagings are updated irregularly and some are not SwiftPM packages.
- **Building libwebrtc from source in CI.** Hours per build and a large toolchain; not justified for a DataChannel.

## Consequences

- Upgrades are deliberate: change `exactVersion`, run the simulator suite and the nightly iOS ↔ Web interop.
- The binary is about 20 MB per architecture slice; App Store thinning removes the slices a device does not need.
- libwebrtc calls delegates on its own threads; the adapter only forwards events, and the controllers apply them in order on their own queue (`EventQueue`).
