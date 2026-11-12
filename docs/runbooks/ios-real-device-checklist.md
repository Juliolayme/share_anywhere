# iOS real-device checklist

Status of every item: **manual, untested in CI.** The simulator suite (`ios-simulator`, nightly `ios-matrix`,
`ios-background-suspend`, `ios-web-interop`) cannot cover cameras, Universal Links, real background timing, the Files
app on a device, or VoiceOver. Run this list on a physical iPhone before a release and record the device, iOS version,
build and result next to each item. Nothing here has been run yet (Phase 7).

## Setup

1. Build a Debug or Release app signed with a development team (Xcode → Signing & Capabilities). CI builds are signed
   ad hoc for the simulator only (docs/ADR/0022).
2. Point it at a reachable HTTPS backend: `xcodebuild … SA_BACKEND_URL=https://<host> SA_PUBLIC_URL=https://<host>`.
   Release builds refuse plain HTTP.
3. Have a second device with the Web app or the Android app for the other side of each transfer.

## Camera QR (RX-1)

- [ ] Receive → Scan QR asks for the camera with the usage text from `Info.plist`; Allow opens the viewfinder.
- [ ] Scanning the sender's QR (Web, Android or another iPhone) opens the join preview of that session.
- [ ] A QR for another origin, or not a share link, shows "This QR code isn't a Share Anywhere link." and nothing opens.
- [ ] Denying the camera shows "Camera access is off" with Open Settings; turning it on in Settings and returning
      shows the viewfinder.
- [ ] Leaving the scan tab or the screen turns the camera off (the green indicator goes away).

## Universal Links (RX-3)

- [ ] `https://<host>/.well-known/apple-app-site-association` is served by Caddy with `Content-Type: application/json`
      and lists the app's Team ID and bundle ID for `/j/*`.
- [ ] Tapping a share link in Messages or Mail opens the app's join preview, not Safari.
- [ ] A link whose join window ended shows "Code expired — ask the sender for a new code".
- Build: a Release build signed with the team's profile, `SA_APPLINKS_HOST` set to the public host (it fills the
  `applinks:` associated domain in `ShareAnywhere-Release.entitlements`) and `SA_APPLE_APP_ID` set on Caddy. The
  `shareanywhere://` scheme brings the app forward but opens nothing outside UI tests; only Universal Links
  open the join preview.

## Background suspension timing (ADR 0027)

- [ ] Start a 2 GB receive, press the Home button: the transfer keeps going for at most about 20 s, then pauses; the
      other side shows Paused; the notification "Transfer paused — reopen the app to resume" arrives (notifications
      allowed).
- [ ] Reopen the app: the transfer resumes from the last verified block (no restart from 0) and finishes with the
      SHA-256 verified.
- [ ] Lock the iPhone during a transfer: same behaviour as Home; the keep-open banner said so beforehand.
- [ ] Same for sending: the receivers see Paused, and the session resumes when the app returns.
- [ ] Low Power Mode on: record how long iOS lets the grace period run.

## Keep screen on (docs/ARCHITECTURE.md §7)

- [ ] With the setting on, the screen does not dim while waiting for receivers, waiting for approval, or while bytes
      move; the pill reads "Screen stays on".
- [ ] It dims normally after completion, pause, cancel, removal and session end, and with the setting off
      ("Screen-on is off in Settings").

## Files app integration (RX-5b, RX-7)

- [ ] Received files appear in Files → On My iPhone → Share Anywhere under the sender's file names; no `.sa-*.part`
      files remain after completion.
- [ ] Choose folder → an iCloud Drive folder and a USB drive folder: files land there; the choice is remembered for the
      session after a relaunch.
- [ ] Open in Files opens the Files app at the received file; Share offers the system share sheet.
- [ ] Sending: files picked from iCloud Drive (downloaded and not yet downloaded) and from another provider are read
      in place; a 4 GB file does not double the used storage.
- [ ] Storage full during a receive shows "This device ran out of storage space." and keeps finished files.

## VoiceOver walkthrough

- [ ] Transfer home: Send files and Receive files are announced as buttons with their subtitles.
- [ ] Session: the code is read digit by digit ("Code 1 2 3 4 5 6"), the QR has its label, the countdown is
      readable, and participant actions say whom they act on ("Remove Kitchen iPad").
- [ ] Receive: the code field is "6-digit code"; progress bars announce a percentage; Pause, Resume and Cancel are
      reachable; the result is announced.
- [ ] Dynamic Type at accessibility XXXL: no clipped text on Send, Session, Receive and the result (the nightly matrix
      covers layout on the simulator; check readability on a device).
