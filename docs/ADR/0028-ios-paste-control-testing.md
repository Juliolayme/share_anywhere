# ADR 0028: Testing iOS's Paste control and pasteboard reads

Status: Accepted (Phase 7, milestone 7.4, 2026-11-12)

## Context

The Clipboard tab syncs with iOS's Paste control (`UIPasteControl` through SwiftUI `PasteButton`), with "Read the clipboard instead" as a fallback, and captures text copied in another app when the app returns to the front (PRD §2 "Clipboard iOS", §7.3b). The phase file asks for an XCUITest of the `UIPasteControl` sync, and the exit gate (docs/phases/README.md, Phase 7) lists "`UIPasteControl` tests pass".

On the macOS 15 runner (Xcode 16.4, iOS 18.5 simulator) three CI runs showed that XCUITest cannot operate the control. The control is a secure system control drawn out of process:

- `tap()` fails, because its scroll-to-visible accessibility action returns `kAXErrorCannotComplete`. Its neighbours in the same card fail the same way.
- A coordinate tap on its centre is delivered, but the control does nothing: no paste, no read.

Two other findings came from the same runs. `UIPasteboard.detectPatterns` never called back on that runtime. The simulator's password AutoFill swallows typing in a new-password field on a sign-up form.

## Decision

- **Simulator UI tests assert the Paste control is shown and sync through the fallback button.** The fallback is a programmatic read, which iOS confirms with its Allow Paste prompt; the tests tap Allow Paste when the runtime shows it. They do not operate the Paste control. Foreground capture on return and no capture in the background are asserted end to end: the second account device sees nothing while the app is in the background, then the item once the app returns.
- **Tapping the Paste control is a real-device check** (`docs/runbooks/ios-real-device-checklist.md`, Clipboard Sync), alongside the paste prompt as users see it and Universal Clipboard.
- **`detectPatterns` has a one-second limit.** If it does not answer, the text counts as not flagged and is read, and iOS asks first. The engine's own sensitive-text check (`Sensitive.kind`) still runs on the text before anything is sent. Whether devices answer within the limit is on the real-device checklist.
- **Under UI tests only, a new-password field is a plain text field.** `AppConfig.uiTestingProcess` is false in Release builds, where the field stays a `SecureField` with `.newPassword`.
- The Phase 7 exit gate and the phase file's test list point here. The `UIPasteControl` item is met by "control shown, fallback sync, foreground and background capture tested on the simulator; Paste control tap on the real-device checklist".

## Alternatives considered

- **Marking the Paste control sync as a known failure in CI.** Rejected: a test that cannot pass proves nothing and teaches people to ignore red.
- **Replacing `PasteButton` with a plain button.** Rejected: only the system control shares the clipboard without a prompt, which is why the design asks for it.

## Consequences

- No CI job operates the Paste control. Until the real-device checklist is run, the report marks that path untested.
- With `detectPatterns` slow or silent, a likely one-time code may be read after iOS's prompt instead of skipped unread. The engine's heuristics still keep it from syncing when Skip sensitive content is on.
