# QA — Phase 6 (Android app)

Independent review by the `qa-reviewer` agent (`.claude/agents/qa-reviewer.md`). The agent is read-only; the engineer applies fixes and the agent re-runs. Instrumentation tests run only in CI (Android emulator with KVM); this session has no KVM.

## CI history of the phase (milestones 6.3–6.5)

- [43094859549](https://github.com/Juliolayme/share_anywhere/actions/runs/43094859549) on 8a2ab0c: every test step green, including the emulator instrumentation; the run is red because GitHub's artifact upload service returned HTML (`Failed to CreateArtifact`). Infrastructure.
- Nightly [43094859572](https://github.com/Juliolayme/share_anywhere/actions/runs/43094859572) on 8a2ab0c: `android-web-interop` red. Web → Android failed (the Web sender page was reloaded by the spec, dropping its picked file); Android → Web passed.
- [43099887625](https://github.com/Juliolayme/share_anywhere/actions/runs/43099887625) on 646fe39: emulator green; `android` red on a flaky `EngineTest` (a test race, fixed in 9f7a7c4 together with a real lost-wakeup bug in `Drain`).
- [43104740023](https://github.com/Juliolayme/share_anywhere/actions/runs/43104740023) on c194412 (accounts and Clipboard screens): emulator red on `AccountClipboardTest` (the phrase confirmation row was not clickable as a whole; fixed in 414e89a as an accessibility fix).
- [43107612448](https://github.com/Juliolayme/share_anywhere/actions/runs/43107612448) on 414e89a, [43113095382](https://github.com/Juliolayme/share_anywhere/actions/runs/43113095382) on 9cc5d4f, [43115861539](https://github.com/Juliolayme/share_anywhere/actions/runs/43115861539) on 932e14e: emulator red on new 6.5 tests while they were stabilised (below-the-fold list items, window flag timing, DocumentsUI navigation, the notification permission dialog over screenshots, device Back hiding the keyboard). Every other job green.
- Nightly [43113095320](https://github.com/Juliolayme/share_anywhere/actions/runs/43113095320) on 9cc5d4f: **`android-web-interop` green in both directions** (64 MB each way, SHA-256 checked on both ends). Nightly [43115861477](https://github.com/Juliolayme/share_anywhere/actions/runs/43115861477) on 932e14e: interop, `clipboard-cross-client` and `android-matrix (29)` green; `android-matrix (35)` red on `FgsBudgetTest`.
- [43118282972](https://github.com/Juliolayme/share_anywhere/actions/runs/43118282972) on 437f742: **every job green including `android-emulator (API 34)`** (22 instrumentation tests passed, 3 nightly-only tests skipped; 60 screenshots).

## Round 1 — commit 414e89a — FAIL

3 P0, 4 P1, 13 P2. P0: exit gate not met (emulator red, interop never green, no report); `KeepScreenOnTest` "released on pause"; `AccountClipboardTest` and `SafFolderTest` red. P1: the notification's Sync request re-fired on every return to Clipboard; account data left on disk when the session ended while the app was not running; Clipboard settings never showed save or clear results; screenshot coverage partial.

Fixed in e7e8a50 (and test fixes in 50cdd00, 82d0f25, 9cc5d4f): one-shot notification sync; a guest start wipes leftover account keys, clipboard cache and sync bookkeeping and destroys the Keystore key; CB-6 reports results and disables controls until ready; the paste fallback opens when Android refuses a read without focus; transfer logs code-only; secrets out of saved state; 48 dp phrase row; Room transactions for store writes; engine tests for answers lost in flight; screenshots of signed-in and session screens. The interop failures were test defects (the Web sender page reload; UI polling during long transfers), fixed in 9cc5d4f.

## Round 2 — commit 932e14e — FAIL

2 P0, 2 P1, 8 P2. The round-1 fixes P1-1, P1-2 and P1-3 hold in the code. P0: emulator red at 932e14e (picker detection, device Back, the screenshot permission dialog, one missed foreground capture); nightly API 35 `FgsBudgetTest` red (its `am compat enable` restarts the app process, which hosts the test). P1: screenshot coverage still missing transfer screens; the Send screen and its system picker never driven on the emulator. P2: passwords in the change-password dialog and the pairing code in saved state; the History banner's Turn on history sync failed silently; no regression tests for round-1 fixes; the clipboard test scrolled without asserting; conditional cancel path in `KeepScreenOnTest`; joined receiver after expiry checked by status only; `leftover()` ignores the clipboard store; a hard-coded placeholder.

Fixed in 0d2625c and bce6c05: Back through the Activity dispatcher and the session captured in its own launch; the picker found by its controls; `FgsBudgetTest` without `am compat` (the app targets API 35, so the limit applies), 512 MB file, 2 s budget, diagnostics; content-free capture diagnostics (read and result kinds only). The missed capture: the diagnostics show the system clipboard overlay takes window focus after a copy and the app captures when focus returns (`window focus=false` → `focus=true` → `auto capture: read=Text result=Synced`), the foreground-only behaviour the UI states; the failed run's window did not regain focus within the wait. New `SendFlowTest` (Home → Send → DocumentsUI → Create share session, content URI kept). Screenshots of dashboard, dashboard-done, session-expired, rx-progress, rx-done, history-detail and send in all three variants. The P2s on saved-state secrets, the History banner error, the placeholder and the clipboard row assertion are fixed; the others are in the backlog below.

## Backlog (P2, not blocking)

- Regression tests for the one-shot notification sync, the cold-start wipe and the CB-6 snackbar.
- `KeepScreenOnTest` cancel path runs only if the resumed transfer has not finished.
- `SenderSessionTest` checks the joined receiver stays `JOINED` after expiry; a transfer after expiry is covered by `TransferTest` and interop, not in the same test.
- `leftover()` could also consider the clipboard Room store (rows left by an interrupted wipe are unreadable once the Keystore key is destroyed).
- Screenshots of `key-pair` (QR mode needs a second device; phrase mode is blanked by `FLAG_SECURE`).
- History sync bookkeeping read-modify-write races between a sync pass and a deletion (same structure as the Web).
