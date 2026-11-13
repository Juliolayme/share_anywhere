# QA — Phase 9 (hardening and release readiness)

Independent review by the `qa-reviewer` agent (`.claude/agents/qa-reviewer.md`). The agent is read-only; the engineer applies fixes and the agent re-runs. Android and the iOS app targets build only in CI (no Android SDK or Xcode in the development container); the security review is `docs/qa/PHASE_9_SECURITY_REVIEW.md`.

## CI history of the QA loop

- 49f8c33 (Nightly [43297156045](https://github.com/Juliolayme/share_anywhere/actions/runs/43297156045)): `abuse-soak`, `chaos`, `large-file`, `turn-forced`, `five-receivers`, `visual-snapshots` green; `android-matrix` 29 and 35 ran every instrumentation test including the new `ProcessDeathRestoreTest` green, with one failure in the new `AccessibilitySemanticsTest` (it looked for the bottom bar on the full-screen Send step; fixed in 11ae428). The iOS matrix ran the new `AccessibilityAuditUITests` for the first time and it failed with real findings: text that did not follow Dynamic Type (fixed `.system(size:)` fonts), clipped text, and `fg-3` small text under 4.5:1 (fixed in cc80699 and 590a0bb).
- 11ae428 (Nightly [43300135250](https://github.com/Juliolayme/share_anywhere/actions/runs/43300135250)): first `throughput` run (numbers in `docs/PERFORMANCE.md`); `visual (ios-safari)` failed on Settings because a long generated device name wrapped (fixed text before capture in cc80699); Android audit measured a control below the fold at its clipped size (fixed in cc80699 and 504b8b1).
- cc80699 (Nightly [43303914139](https://github.com/Juliolayme/share_anywhere/actions/runs/43303914139)): Web `a11y` and `e2e-web` green in all five projects; `visual-snapshots` produced the baselines committed in 34738ed. `android-matrix (29)` had an `OutOfMemoryError` cascade (16 MB heap growth limit, 23 tests) that did not recur on 504b8b1 or 6ef3ad7 on the same AVD (intermittent emulator state; recorded). The iOS audit now flagged far fewer items, mostly stock controls, a few real ones fixed in 590a0bb, and two lifecycle test failures: the suspended flag was written after the pause (an app ended right after it lost the flag) and a system cold start carried no UI-test arguments (both fixed in 590a0bb).
- 504b8b1 and 6ef3ad7: every Web job green (`e2e-web` and `a11y` in five projects); Android API 29, 34 and 35 failed only in `SenderSessionTest` where the audit saw two semantics roots while the Block dialog was open (fixed in 590a0bb). `ios` on 6ef3ad7 failed once in `ControllerTests.testAHelloThatArrivesBeforeTheSenderIsReadyIsNotLost` (pre-existing Phase 7 test, unchanged in Phase 9; passed on cc80699 and in 55 Linux runs, 30 of them under CPU load; recorded as an intermittent, not skipped).
- 590a0bb (CI [43311661865](https://github.com/Juliolayme/share_anywhere/actions/runs/43311661865), Nightly [43311662006](https://github.com/Juliolayme/share_anywhere/actions/runs/43311662006)): every CI job green except `ios-simulator`; every nightly Web, Android and backend job green, including `visual` in all five projects, `a11y` in all five, `android-matrix` 29 and 35, `chaos`, `abuse-soak`, `throughput` (three engines) and `ios-background-suspend`. Both iOS lifecycle tests (terminate while suspended, cold start from a link) passed. `ios-simulator` and the iOS matrix failed on: `AppUnitTests` (the remembered UI-test arguments leaked into unit tests' explicit arguments; fixed in 5dd0430), the 6 pt progress bar as a target, contrast reports on navy and `fg-2` text that pass on paper (sampled while views faded in), navigation-title and Form-row clipping, the code field at large sizes, three audits that timed out, and issues the audit names no element for (5dd0430 and cecfd8e; the element-less ones, a repeatable History cluster, are kept as notes, not fixed). `ios-web-interop` passed both transfers and failed in teardown (closing the sender browser took more than 30 s; cbe8ca8).
- cecfd8e (Nightly 43319347823): the UI-test target failed to build (`AuditIssue` used an iOS 17 type without the availability annotation; 4e1ee94); `visual (firefox-desktop)` failed against the old light "dark" baselines, as expected; its `visual-snapshots` produced the regenerated baselines committed in 4e1ee94.
- 4e1ee94 (CI 43321396629, Nightly 43321396834): every Web, Android and backend job green, `visual` in all five projects against the new baselines, the XXXL lane green; `ios-simulator` failed before testing (`hashFiles` timed out on the runner, infrastructure); the SE and Pro Max lanes reported small-screen findings (targets, Welcome, labels, large-type layouts; cb6c8f2).
- cb6c8f2 (Nightly 43325786480): every non-iOS job green; `ios-simulator` and the SE lane failed only on "partially unsupported" Dynamic Type and contrast reports on AA token pairs, moving between screens from run to run (now notes; a4a5693).
- a4a5693 (CI [43332023733](https://github.com/Juliolayme/share_anywhere/actions/runs/43332023733)): **all 21 CI jobs green**, every required check included (`backend`, `web`, `e2e-web` ×5, `protocol`, `security`, `a11y` ×5, `android`, `android-emulator`, `ios`, `ios-simulator`). Nightly 43332023625: everything green except the Pro Max lane (Remove's target; fixed on the label in 507ca64), the SE lane (the resumed 256 MiB receive needed more than five minutes; 507ca64) and `ios-web-interop` (clipboard half: the app did not show the pairing code within 60 s; the transfer halves passed).
- 507ca64: see the final gate.

## Round 1 — commit 11ae428 — FAIL

1 P0 (the exit gate: report uncommitted, no finished CI run), 10 P1, 11 P2. Backend (`go test ./...`, the soak and the IDOR sweep), Web unit (495), axe on chromium, iOS core (110), the production Compose validation and the backup round trip passed in the agent's own runs.

P1 findings and fixes:

1. axe did not cover every route and state (the account steps inside sign-up, `/j/:token`, the drawers, receiver states, sender dialogs) → the spec audits each of them (504b8b1); the new coverage found two real violations, fixed: `fg-3` recovery-phrase numbers and a colour-only link in the clipboard note.
2. Native audits skipped the transfer and account screens → the iOS `audit()` runs inside `TransferUITests` and `AccountUITests`, the Android `assertAccessible` inside `TransferTest` and `SenderSessionTest` (cc80699).
3. Visual baselines for two of five projects; compare jobs could not fail → all five committed, a missing baseline fails (34738ed).
4. Release checklist marked unmet CI items done → unchecked until a green run is recorded (504b8b1).
5. Runbook metrics commands could not work (distroless image) and named a missing metric → metrics published on `127.0.0.1:9090` by the production override; the exported names listed (504b8b1).
6. Rotating `SA_SERVER_SECRET` breaks every live session, not only tickets → stated in the incident runbook (504b8b1).
7. IPv6 clients would collapse onto one address behind Docker's proxy → IPv4 only with this layout, a client-address check in the deploy runbook (504b8b1).
8. Throughput table without CI data → filled from Nightly 43300135250 (cc80699).
9. Undocumented design deviations from the a11y fixes → `docs/design/DESIGN_DEVIATIONS.md` section P (504b8b1).
10. Licenses item (design F7) neither delivered nor rescheduled → open-source notices are a release blocker in the checklist and an open decision in the PRD and phases README, with account deletion (504b8b1).

P2 fixed: concurrent lookups could pass the lockout together (per-address and per-device serialization, `TestConcurrentLookupsStopAtTheAllowance`, docs reworded: 10 in a row, at most 15 in the first hour; 6ef3ad7); IDOR sweep accepted any 4xx (now 403/404 only, a signed-in stranger with an added device, owner positive controls; 6ef3ad7); soak generator oddities (6ef3ad7); Android resume edge cases (sweep before resume, one-day filter, cleanup when every transfer ended while the process was dead; 6ef3ad7); iOS pending entries and resume gating (6ef3ad7); release checklist details (wake lock, Argon2id, screenshot sizes, privacy manifest device ID linked; 504b8b1); deploy details (Compose 2.24.4, exporter firewall rule; 504b8b1); focus after Welcome on the Web (e2cac2b); `lint:md` skips Playwright output (504b8b1); account deletion has owners (PRD open decisions, phases README; 504b8b1).

P2 kept as is: the language button's accessible name includes the visible `EN`/`VI` code (WCAG 2.5.3 requires the visible text in the name; the codes are the design's label, not prose).

## Round 2 — commit 590a0bb — FAIL

Exit gate open (report uncommitted, no green `ios-simulator` yet), 1 P1, 9 P2. Round 1 fixes verified in code and in the agent's own runs: backend (`go test ./...`, the lockout tests 40/40 under `-race`, a mutation check removing the gate made the new test fail), Web unit (495), axe and keyboard on chromium (8/8 after a fresh web build), iOS core (110), SwiftFormat, ktlint, the production Compose rendering and every named metric against a live `/metrics`.

P1 finding and fix (eaa2631):

1. The Firefox `dark` visual baselines were light screenshots (10 of 12 identical to their light pair): Firefox did not apply the context's colour scheme. The spec now sets the theme through the app's preference as well and asserts `data-theme` before each capture; the baselines are regenerated from the next nightly.

P2 fixed: the `ControllerTests` HELLO timeout traced to the test fake opening one end of a channel before the other (both ends now open before any open action runs; eaa2631); the Android start-up sweep left half-written documents of the receives it forgets (deleted first; eaa2631); the iOS audit filters were broader than needed (the seed-name clipping skip removed, the partial Dynamic Type skip limited to navigation-bar items and Form/List rows, judged after the audit; eaa2631); Debug builds kept test launch arguments forever (they expire after 15 minutes, and explicit arguments are used as given; eaa2631, 5dd0430); a caller already locked out queued behind the lookup gate (refused before it; eaa2631); the axe spec's header claimed dark for every flow (corrected; eaa2631); the desktop home baseline included a per-run device name (fixed text and mask; eaa2631); forget-pending and resume ran as independent tasks (one task, forget first; eaa2631).

P2 kept: `SAFont` uses `Font.custom` with a name no font has, relying on the documented fallback to the system font, for the 40 pt display step and the logo wordmark only; `.system(size:)` with a scaled metric is what the audit reported as not following Dynamic Type. The API 29 emulator OOM (16 MB heap growth limit on one boot) is infrastructure; a boot check in the workflow is backlog.

Intermittents seen during the loop, none in Phase 9 code paths: `ControllerTests.testAHelloThatArrivesBeforeTheSenderIsReadyIsNotLost` once on macOS (cause found in the test fake, fixed); `ClipboardEngineTests.testRemoveAndClearReachEveryDevice` once locally in about 70 runs (pre-existing Phase 7.4 test; backlog).

## Round 3 — commit 507ca64 — FAIL

Exit gate open (report uncommitted), 1 P1, 9 P2. Round 2 fixes verified: all 60 dark baselines are dark (mean luminance 30–64 against 209–249 for light, no identical pair), CI 43332023733 green in 21/21 jobs, backend, Web, iOS core and axe/keyboard on chromium green in the agent's own runs, the MemPeer fix 10/10.

Change of direction recorded here: after round 2 narrowed the iOS audit filters (eaa2631), CI showed that several audit categories were not dependable on the simulator: pixel-sampled contrast flagged AA pairs (navy on white, 13:1) across two passes, "partially unsupported" Dynamic Type moved between screens from run to run, some issues named no element, and audits timed out. The filters were widened again in steps, each documented: clipping inside navigation bars and Form/List cells skipped (5dd0430), element-less issues as notes (cecfd8e), any single file name skipped for the label check (cb6c8f2), contrast and partial Dynamic Type as notes (a4a5693). What still fails is element descriptions, hit regions, traits, Dynamic Type "unsupported" and clipping elsewhere; colour contrast on iOS rests on the token check and Web axe.

P1 finding and fix:

1. `docs/TESTING_AND_CI.md` still said every audit issue fails → it now lists the fail, note and skip classes as the code has them.

P2 fixed: the audit helper's dead contrast recheck and tab-bar logic removed, notes collected per screen with one screenshot, partial Dynamic Type routed only through the note rule; the cell/navigation-bar skip scope stated (it covers our own History and Settings rows); hiding the progress bars lost the percentage, which is now the value of the dashboard's "Overall" label and of each receiving file row; Pause and Resume on the receiver card get 44 pt targets on their labels; the interop wait for the pairing code prints the UI tree on timeout; a typing helper waits for keyboard focus (a Pro Max sign-up failure); DESIGN_DEVIATIONS §P lists the large-text layouts, hidden bars and targets; the report and KNOWN_LIMITATIONS name the History no-element cluster, the interop stall triage, the SE resume gap and the iOS lanes' history.

P2 recorded as backlog: the interop stall (about 67 s inside adding the device, once; not reproduced on the runs before or after), the SE resume duration, the History no-element notes.

## Final gate

To be completed after round 2 and the CI run on the final commit.
