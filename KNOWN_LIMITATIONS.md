# Known limitations

What Share Anywhere v1 does not do, or does only partly, and what has not been verified. Consolidated from PRD §6.8 (browser capabilities) and §7 (Clipboard Sync), the security model, and the phase reports (`docs/phases/reports/`). The phase reports hold the detail and the evidence.

**Test status.** Every claim of "tested" below means the Playwright browser projects (desktop Chromium, Firefox and WebKit, plus Pixel 7 and iPhone 14 emulation), the Android emulator (API 29, 34, 35), or the iOS Simulator (iPhone 16, SE, 16 Pro Max on iOS 18.x). **Nothing has run on a real Android phone, a real iPhone, a real iOS Safari, or across real networks.** The real-device checklists are `docs/runbooks/ios-real-device-checklist.md` and `docs/RELEASE_CHECKLIST.md` §4.

## 1. Web (browsers)

| Capability | Chromium 120+ (desktop, Android) | Firefox 120+ | Safari 17+ (macOS, iOS) |
|---|---|---|---|
| Send large files (`File.slice` streaming) | Yes (tested, 2 GB nightly) | Yes (tested) | Yes (tested on WebKit) |
| Save straight to a folder (File System Access) | Yes (tested) | No | No |
| Save in browser storage (OPFS), then download | Yes (tested) | Yes (tested) | Yes on WebKit; quota and tab suspension on iOS untested on a real device |
| Receive more than 2 GB | Yes when storage allows (tested, 2 GB nightly) | Depends on the storage quota; the app checks the free space first | Usually no on iOS; the app warns above 2 GB |
| Browser without OPFS | In-memory receive up to 256 MiB, then refused with an explanation | same | same |
| Clipboard read on a tap | Yes (permission prompt) | Yes (paste prompt) | Yes (paste prompt) |
| Automatic clipboard capture | Best-effort on focus | Not reliable | Not reliable |
| Transfer continues in a background tab | Yes, throttled | Yes | iOS suspends the tab; the app asks the user to keep it open |

- A website cannot see clipboard changes made in other apps while it is not in front. The UI says capture is on focus only, best-effort, or manual.
- Picked files exist only in the sender's tab: reloading the sender loses them, and receivers see "The sender's tab no longer has the files".
- Private (incognito) windows may keep browser storage in memory, so a large receive can fail with "This device ran out of storage space"; the capability check cannot detect it.
- Firefox gathers WebRTC candidates in default-route mode for this app (no camera or microphone permission is asked for): a Firefox receiver that reloads mid-transfer, or one on a LAN without internet, may fail to connect (seen in CI, untested for real users). Firefox also ignores TURN servers on loopback, so the forced-relay suite runs on Chromium only.
- No "Open" or "Show in folder" on the Web, no Retry for one failed receiver, no "Send again" from History; a failed whole-file checksum ends that receive (design gaps G3, G4, G12, G16 in `docs/design/DESIGN_DEVIATIONS.md`).
- Browser access tokens live in memory, so each new tab refreshes once at start.

## 2. Android

- Android 10 and later block clipboard reads in the background: capture happens only while the app is in front, and the UI states it. Sensitive clips (`EXTRA_IS_SENSITIVE`) are skipped. No input-method (keyboard) capture in v1.
- Transfers run in a `dataSync` foreground service with a notification. Android 15 limits `dataSync` services to about 6 hours a day; a longer transfer stops with a notice (untested on a device).
- Process death during a receive resumes from the saved block map at the next start (emulator test with 192 MB); real-device memory-pressure kills, Doze and OEM battery savers are untested.
- Camera QR scanning, App Links verification (needs the release signing certificate's SHA-256 in `assetlinks.json`), storage-full on a real device, and TalkBack with a real user are untested.

## 3. iOS

- `UIPasteboard` is readable only while the app is in front; there is no background clipboard access, and the UI states it. Programmatic reads show iOS's paste banner; the Paste control avoids it, but XCUITest cannot press it, so syncing through it is untested. Universal Clipboard text that arrives while the app is in front is treated as an in-app copy and not captured (deviation N.3).
- iOS suspends the app in the background: a transfer pauses and resumes when the user returns (the app posts a local notification). A terminated app resumes unfinished receives at the next launch (simulator test). Real suspension timing, screen lock, Low Power Mode, and a long transfer under real background limits are untested.
- The iOS 16 deployment target is compiled for but runs only on iOS 18.x simulators (the CI image has no older runtimes).
- Untested on a real iPhone: camera QR scanning, Universal Links, the Secure Enclave key path, the document picker with iCloud Drive and other providers, storage full, VoiceOver with a real user.
- Change password and two-step verification are not offered on iOS (deviation section N).
- After sign-in, Add this device has twice paused for about 60 s before the key check on loaded CI simulators (the server answered at once; the time is spent on the device). The cause is not found yet; whether it happens on a real iPhone is untested.
- The automated iOS accessibility audit does not fail on contrast or on "partially unsupported" Dynamic Type (both are kept as notes; the pixel-sampled checks were unreliable in CI), nor on issues that name no element (notes; History repeatedly reports Dynamic Type and clipping issues without an element, still to be identified with the Accessibility Inspector). It skips clipping inside navigation bars, Form/List cells (which includes our own History rows and Settings rows) and search fields. iOS colour contrast rests on the check of the declared token pairs and Web axe; colours composited at run time (the tinted chip backgrounds) are not checked automatically. A review with the Accessibility Inspector on a device is open.

## 4. Network, relay and Cloud

- Relay and route-migration tests run on loopback in CI; the production coturn configuration denies private and loopback peers. No test ran across real NATs, cellular networks, or captive portals.
- TURN over TLS on port 443 needs a second public IP address (Caddy holds 443); the default deployment offers TURN over TLS on 5349, which some strict networks block.
- Guest relay use is capped per session (`SA_GUEST_RELAY_BYTES_CAP`); the cap fails open if coturn's usage exporter is unreachable. The exporter grows one series per ephemeral username, so coturn needs a periodic restart (ADR 0029).
- Cloud Distribution is proxied through the backend (no presigned URLs or CDN), so its throughput is bounded by the server's bandwidth. A cloud download restarted after an app restart starts again at the first part.

## 5. Security and abuse limits (accepted residual risks)

- **Open join** admits anyone with a valid code inside its 10-minute window. Protected mode (approval for code joins) trips when failed lookups pass 300 a minute across the service; a slow, distributed guesser below that rate gets about 2,900 guesses per window across all live codes (`docs/SECURITY_MODEL.md` §3.2, ADR 0031). Links and QR codes carry 128-bit tokens and are not affected.
- **Shared IPv4 addresses (CGNAT, offices, schools):** per-address limits count every user behind one address together, for example 30 new sessions per hour and 3 new device identities without proof-of-work (ADR 0031). There is no allowlist.
- A device removed from an account keeps the history and clipboard key versions it already had and can still decrypt items encrypted before the rotation; later items use a key it never receives.
- Losing every signed-in device and the 12-word recovery phrase makes old history and clipboard items unrecoverable (by design; the UI says so).
- `golang.org/x/crypto/openpgp` carries an advisory (GO-2026-5932) in an indirect dependency that the backend never calls (`docs/qa/PHASE_9_SECURITY_REVIEW.md`).

## 6. Operations

- The production Compose override and Caddyfile are validated with `docker compose config`, `caddy validate` and a backend start, but no deployment to a real VM with a public domain has been done (`docs/runbooks/deploy.md`).
- **Account deletion is not built** (no endpoint, no screen; the design handoff has none). Google Play and the App Store both require in-app account deletion for apps with sign-up, so this blocks store submission until a later phase adds it. Signing out leaves the account, and guests have no account to delete.
- **Open-source notices are not shown in the apps** (no Licenses screen, design F7): a release blocker for binary distribution (`docs/RELEASE_CHECKLIST.md` §1).
- No store submission has been made: signing, Play policy forms, App Store privacy answers and export compliance are prepared but unsubmitted (`docs/RELEASE_CHECKLIST.md`).
- Throughput numbers come from loopback in CI and local runs (`docs/PERFORMANCE.md`), not real networks.
