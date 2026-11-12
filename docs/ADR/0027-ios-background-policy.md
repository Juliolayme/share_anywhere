# ADR 0027: iOS background policy for transfers

Status: Accepted (Phase 7, milestone 7.3, 2026-11-12)

## Context

iOS suspends an app shortly after it leaves the screen. Transfers run over a WebRTC DataChannel that needs the process alive. The phase file rules out audio, VoIP and location background modes and keeps `BGProcessingTask` for clipboard sync and cleanup. PRD §2 and §5.10 ask that iOS users see that locking the iPhone pauses the transfer and that it resumes when they come back.

## Decision

- **Keep the screen on while it matters.** `UIApplication.shared.isIdleTimerDisabled` is true only while a transfer moves bytes, a sender waits for receivers, or a receiver waits for approval, the setting **Keep screen on during transfers** (default on) is on, and the scene is active (`KeepAwake`). It goes back to false on completion, failure, pause, cancel, removal, the session ending, the setting going off and on `.background`, and is applied again on `.active`. Every such screen shows the keep-open banner with "Locking your iPhone pauses the transfer" and the screen-on pill.
- **A short grace period, then pause.** On `.background` with a transfer in progress, `TransferHub` starts `beginBackgroundTask` and lets the transfer continue for up to 20 seconds (shorter in UI tests via `-backgroundGrace`). Then, or earlier if iOS calls the expiration handler, every active transfer is paused through the normal pause path (the receiver's bitmap is already persisted after each verified block, and the pause is reported to the server so the other side shows Paused), and the local notification `ios.susp_h` ("Transfer paused — reopen the app to resume") is posted when notifications are allowed.
- **Resume on return.** On `.active`, transfers paused by the background policy (not those the user paused) resume through the normal resume path, which redials when the connection was lost, and continue from the last verified block.
- **No background modes** in `Info.plist`; nothing pretends to be audio, VoIP or navigation.

## Alternatives considered

- **Background `URLSession` uploads/downloads.** They cannot carry a peer-to-peer DataChannel; Cloud Distribution (Phase 8) may use them later for the cloud route.
- **Audio or VoIP background modes to stay alive.** Against App Review rules and the phase file.

## Consequences

- A transfer to or from iOS stops a few seconds after the user leaves the app; the UI says so before it happens and the notification explains how to continue.
- Real background timing on devices (how long iOS actually grants) is only checked on hardware (docs/runbooks/ios-real-device-checklist.md); the simulator test uses the same code path with a short grace period.
