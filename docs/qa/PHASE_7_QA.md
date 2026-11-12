# QA — Phase 7 (iOS app)

Independent review by the `qa-reviewer` agent (`.claude/agents/qa-reviewer.md`). The agent is read-only; the engineer applies fixes and the agent re-runs. The app and UI-test targets build only on the macOS runner (Xcode 16.4, iOS 18.5 simulator); in this Linux session the reviewer ran the Core package tests (`swift test`), SwiftFormat and SwiftLint over all of `ios/`, and the i18n check, and read the app and UI-test code. Simulator and nightly results come from CI.

## CI history of the QA loop

- [43163693761](https://github.com/Juliolayme/share_anywhere/actions/runs/43163693761) (milestone 7.3): green including `ios-simulator`; nightly [43166681225](https://github.com/Juliolayme/share_anywhere/actions/runs/43166681225): `ios-web-interop` green in both directions with SHA-256 checks, `ios-background-suspend` green.
- d28ebdf to a5a9dda (7.4 UI): the simulator suite did not compile (a missing `try` in `AccountUITests`), then the account and link tests failed on the Paste control (scroll-to-visible), the Settings tab index, `XCUIApplication.open` relaunching with `-resetState`, and sign-up typing.
- 8565ad4 to 4f2ce54: result bundles downloaded and read (accessibility trees, `-uiTesting` probes); the causes above fixed one by one. The macOS `ios` job caught the `ReporterTests` flake that turned out to be a real throttling bug (622df03).
- 9d7af09: the account sheet left open after Go to Clipboard (app bug) found and fixed; nightly showed the main thread blocked by the pasteboard read (fixed in 6908ed2). The Android API 34 job failed once on the intermittent Compose `SnapshotStateObserver` crash already in the Phase 6 backlog (Android code unchanged); it was green on every later run.
- 6908ed2: `ios-web-interop` green for the first time with the clipboard step (64 MB each way and the encrypted clipboard exchange), Pro Max and XXXL green; the only remaining failure was Sign out below the fold.
- [43209011319](https://github.com/Juliolayme/share_anywhere/actions/runs/43209011319) on 620519f: **every CI job green including `ios-simulator` (iPhone 16, iOS 18.5) and `android-emulator (API 34)`**. Nightly on 620519f: `ios-web-interop`, `ios-background-suspend`, Pro Max and XXXL green; SE red on two small-screen steps (fixed in 2f0aa95).

## Round 1 — commit d28ebdf — FAIL

P0/P1 findings on the screen-on pill (a label, not a control), background expiry resuming receivers that were not active, the guest Clipboard tab reading `UIPasteboard.changeCount`, test hooks and the `shareanywhere://` scheme reachable in Release builds, a receiver that never reported a file it could not move into place, and missing tests (pill toggle, screen-on after cancel, the joined receiver completing after the code expired).

Fixed in a5a9dda: the pill is a button (off for this transfer, on again, turn the setting back on); only receivers that were active are paused and resumed; the change count is read only while Clipboard Sync observes; `-uiTesting` hooks exist only in Debug builds, Release carries the `applinks:` associated domain; the finish failure is reported with `product.tx_err_storage_app` and long extensions are clamped; pairing polls again after the phrase screen, clipboard snapshots stop with the engine, the camera stops when Receive is hidden, the key vault is excluded from backups; the three tests added; docs corrected.

## Round 2 — commit a5a9dda — FAIL

0 P0, 2 P1, 8 P2. P1: no test that screen-on is off after the app leaves the screen, while the testing doc claimed one; the PRD's iOS foreground capture ("on `changeCount` change while active") was not built and its tests were missing.

Fixed in fb4bbf6: the `-uiTesting` probe `test.idle-on-background` records `isIdleTimerDisabled` as applied on backgrounding and `TransferUITests` asserts it is false; foreground capture runs when the app returns with a changed pasteboard (`detectPatterns` skips a likely code without reading; iOS confirms the read with its paste prompt), observation follows the account session rather than the Clipboard tab, a read marks the change seen before the prompt; `AccountUITests` asserts no capture while the app is in the background (seen from the other account device), capture on return, and the fallback button read. P2s fixed: the custom scheme and `-publicURL` only with `-uiTesting`, the pill's paused state and selected trait, the join preview's clock offset computed once.

## Round 3 — commit fb4bbf6 — FAIL

0 P0, 1 P1, 7 P2. P1: the iOS "As built" test notes had been appended to the Android section of `docs/TESTING_AND_CI.md` while the iOS section still described a removal assertion and a `-uiTesting` pasteboard hook. P2: a Core test flaked once in 19 local runs; copies made before the engine was ready were lost; the engine restarted on every state change while keys loaded; the hint cleared for results that did not sync; a read without text on the pasteboard; in-app copies only hinted; `-publicURL` not listed.

Fixed in cf5f03a and c44dd26: the Android bullets restored and the notes moved to §5b; a change stays unseen until the engine runs; no restart while the engine task is pending; the hint clears only for synced, queued or duplicate text, with a toast for text that is too large; `hasStrings` before any read; `-publicURL` listed; the flaky `ReporterTests.testProgressIsThrottled` (the same test failed once in the macOS `ios` job) uses a 10 s interval. CI findings fixed in the same commits: the Paste control is tapped where it is drawn (XCUITest cannot scroll a secure system control into view), Settings is found as the last tab now that Clipboard is a tab, share links reach the app through one inbox fed by the scene delegate and SwiftUI, the new-password field avoids the simulator's Strong Password under UI tests, and the cancel test keeps the receive connecting until it is cancelled.

## Round 4 — commit c44dd26 (and aa9a8a0) — FAIL

0 P0, 1 P1, 6 P2. P1: deviation N.3 and the report said in-app copies are captured at the next return; the code never captures them. P2: a share link at cold launch could be lost (`onChange` does not fire for an initial value); the Paste control tap did not check the control was on screen; the sign-up test could pass without the Paste control; the hint after the app's own Copy code and after non-text copies; empty or removed results left the hint up; the cancel test covers cancel while connecting only.

Fixed in 206a6b6: N.3 and the report state that in-app copies are never captured automatically; an in-process change is marked seen with no hint, non-text changes show no hint; links and the quick action are taken with `onReceive`, which delivers a value set before the view appeared; `tapPasteControl` requires the control inside the window and the sign-up test requires the control. The cancel-while-transferring case is in the backlog.

## Round 5 — commit 206a6b6 — PASS

0 P0, 0 P1, 7 P2. Every round-4 finding verified fixed and the docs match the code (`UX_SCREEN_MAP.md` CB rows, `TESTING_AND_CI.md` §5b, deviation N.3, report §1 and §6). Local: `ioscheck.sh` IOS-GATE-OK (SwiftFormat, SwiftLint `--strict`, 94 Core tests, 0 failures), i18n catalogs current.

P2s fixed afterwards in 8565ad4: the link and quick-action values are cleared on the next main-queue turn (`@Published` sends from `willSet`, so a reset inside the handler was overwritten); both Copy code buttons write through `PasteboardAccess`, which marks the change seen at once and clears a stale hint; N.3 says "before Clipboard Sync was ready" and records Universal Clipboard arrivals reported in-process as a departure from PRD §7.3b pending device verification. Left in the backlog: no UI test for "in-app copies are never captured", `tapPasteControl` does not exclude the tab bar area.

## After round 5: defects found by the simulator runs

The account and clipboard UI tests had not completed on the simulator before the QA loop; once the result bundles were downloaded (the failing step's accessibility tree, the `-uiTesting` probes), each failure was traced to its cause:

- **App bug: Go to Clipboard left the account sheet open** (back on key setup, covering the Clipboard tab), and Not now on Add this device after sign-in only went back a step: `dismiss()` in a pushed screen pops it. Fixed in 9d7af09 with a close-sheet action in the environment; the tests assert the sheet is gone.
- **App bug: `UIPasteboard.detectPatterns` never called back on the iOS 18.5 simulator**, so the fallback read (and foreground capture) waited forever: zero pasteboard reads after the tap. Fixed in 4f2ce54 with a one-second limit (not flagged; the engine's own sensitive check still runs).
- **App bug: progress reports in flight let a second report through** (iOS and Web reporters stamped the last send only after it returned). Fixed in 622df03 with regression tests that fail without the fix; Android was not affected.
- **Test defects:** iOS's Paste control ignores XCUITest taps and its neighbours cannot be scrolled into view by XCUITest (tests now assert the control is shown and sync through the fallback; tapping it is on the real-device checklist); the simulator's password AutoFill swallowed typing in the new-password field (a plain field under UI tests); `XCUIApplication.open` relaunched the app with `-resetState` (links are opened through `XCUIDevice.system.open`); Settings became the fifth tab; a 128 MB receive finished before Cancel; switches below the fold; the backend `TestWebSocketFanOut` discarded presence events that settled out of order (5c92bf4).

## Round 6 — commit 9d7af09 — FAIL

0 P0, 2 P1, 8 P2. The app changes after round 5 (sheet close, `detectPatterns` limit, reporter fix, link inbox, test helpers) were judged sound. P1: the exit gate and the phase file still required a `UIPasteControl` sync test that no longer exists; `docs/TESTING_AND_CI.md` still said the interop and simulator tests use the Paste control. P2: the sheet-closed assertion could not fail (`account.close` is never on the pushed checklist); no test for Not now on Add this device; the `detectPatterns` limit not in the owner docs; the trace probe appended without bound; a misplaced doc comment; the UI-test-only plain password field undocumented; report §6 behind deviation N.3; no iOS test that deferred progress is sent.

Fixed in e96e372: ADR 0028 records that XCUITest cannot operate the secure Paste control (control asserted shown, sync through the fallback read, the tap on the real-device checklist), the one-second `detectPatterns` limit and the UI-test-only plain password field; the gate row, the phase test list and `TESTING_AND_CI.md` point to it. The sheet assertions check that the checklist and key screens are gone; the probe assigns; N.3, the runbook and report §6 updated; a Core test for progress sent when the interval ends.

## Round 7 — commit e96e372 — PASS

0 P0, 0 P1, 7 P2. ADR 0028 accepted as the resolution of the `UIPasteControl` gate item: no document claims the tap works (CLAUDE.md rule 9), the tap is on the real-device checklist as the phase prescribes for device-only behaviour, and the only code the simulator cannot reach is the `PasteButton` handler, which calls the same `sync` the fallback path exercises end to end. Local: IOS-GATE-OK (96 Core tests), i18n current, markdownlint 0 errors.

P2s fixed in 6908ed2: the new Reporter test uses a manual clock and sleeper (no wall-clock dependence); the `AccountUITests` class comment, the planned §5b sentence ("superseded by ADR 0028"), N.3 (the `detectPatterns` departure from PRD §2/§7.3b) and report §6 (ADR 0028, the plain password field) corrected; a stale backlog item removed. In the same commit, from the nightly matrix: the pasteboard read runs off the main thread (it waits for the person to answer iOS's prompt, which froze the app and timed out XCUITest queries), and the tests look for Allow Paste in SpringBoard first.

## Final gate

- [43215838875](https://github.com/Juliolayme/share_anywhere/actions/runs/43215838875) (CI) and [43215838879](https://github.com/Juliolayme/share_anywhere/actions/runs/43215838879) (nightly) on 2f0aa95: **every job green**. That covers the simulator XCUITest suite on iPhone 16 (guest send and receive, open join, the expired code with Create new code and the joined receiver completing, Remove and Block, approval, keep screen on including the pill and the background value, the share link, cancel, accounts and Clipboard Sync with foreground capture and background non-capture), the four-device matrix, background-suspend resume, iOS ↔ Web 64 MB both ways with SHA-256, and the iOS half of `clipboard-cross-client`.
- Core: 96 tests, 0 failures locally and in the `ios` job; SwiftFormat and SwiftLint clean; i18n current.
- QA round 7 PASS; the round-7 P2s fixed in 6908ed2.
- Exit gate (docs/phases/README.md, Phase 7): met, with the `UIPasteControl` item as narrowed by ADR 0028. Real-device behaviour (camera QR, Universal Links, background timing, Secure Enclave, the Paste control tap, Universal Clipboard) stays untested until `docs/runbooks/ios-real-device-checklist.md` is run.

## Backlog from QA (P2)

- UI test that an in-app Copy code is neither captured nor hinted.
- UI test for Not now on Add this device (fixed in 9d7af09, untested).
- Cancel while bytes are moving (the cancel test cancels while connecting).
- Receiver-side Remove with screen-on off afterwards.
- File names bounded by UTF-8 length; the partial file discarded when the final move fails.
- A Release build in CI (the `#if !DEBUG` paths compile only by reading).
- `android-ios-interop` (not built).
