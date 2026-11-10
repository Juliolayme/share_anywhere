# Design deviations

Where the Claude Design handoff (`design/claude-design/`, imported in commit 089e59c) and the product documents disagree. `CLAUDE.md` sets the rule: the design is the UI source of truth, but a product decision in the PRD wins over the design. Each entry says which side wins and what the code does.

## A. Design elements not built because a PRD decision wins

| # | Design | PRD decision | What the code does | Revisit |
|---|---|---|---|---|
| A1 | Email verification with a six-digit code after sign-up (`verify` screen; `ve_*` strings), and a `trust` step that only offers "Trust this device" | No email verification in v1; after sign-in the user chooses to add the device and, separately, to copy local history (PRD §2 Authentication, Signing in) | The `verify` screen is not built. The after-sign-in choices screen (AC-4) uses the design's `trust` layout with two switches, `product.add_device` and `product.copy_history` (section E11) | Backlog: add verification later; strings are kept in the catalogs |
| A2 | Sign in with Apple on iOS | v1 accounts are email + password only | Not built. App Review requires Sign in with Apple only when another third-party sign-in exists, and none does | Backlog |
| A3 | Two-step verification settings (`tf_*` strings) | Not in the PRD | Not built; the Settings row is hidden | Backlog |
| A4 | Transfer strategy picker with "Direct only" and "Prefer relay" | Settings shows transfer strategy Auto (PRD §5.8); route policy is per receiver in the client (PRD §6.3) | Only Auto is offered until Phase 8 decides whether the other two policies ship | Phase 8 |
| A5 | Share link shown as `sa.link/j/482913`, which embeds the six-digit code | Links and QR carry a ≥ 128-bit capability token separate from the code (`CLAUDE.md` §7, `docs/SECURITY_MODEL.md` §3) | Links use the capability token. The UI may display a shortened host for readability but never the code as the link credential | — |
| A6 | Clipboard retention option "Until I clear" | Clipboard retention is 7 days with a 100-item cap (PRD §7.6) | Retention offers 7 days · 100 items (default) and 1 day · 50 items | — |
| A7 | SwiftUI snippets marked "iOS 17+" and History in SwiftData | iOS 16 minimum (`CLAUDE.md` §5, PRD §2) | iOS 16 APIs only; History in Core Data or GRDB (ADR in Phase 7) | Phase 7 |
| A8 | Settings "Cloud Distribution: deleted after 24 h" | Cloud objects follow a configurable TTL and are deleted after completion or expiry (PRD §6.2) | The default TTL is 24 h, matching the design copy; the value is configuration | Phase 8 |

## B. Design decisions adopted into the product documents

These refine the PRD without contradicting it, so the design wins and the owner documents were updated.

| # | Design | Adopted in |
|---|---|---|
| B1 | Three security words on sender and receiver ("maple · river · seven") instead of two | `docs/SECURITY_MODEL.md` §3.1, `docs/ARCHITECTURE.md` §8, PRD §5.3–§5.4 |
| B2 | Sticky keep-open banner on sending, receiving, and waiting screens; Web asks before the tab closes (`beforeunload`); Android repeats the text in the foreground notification | PRD §5.10, `docs/ARCHITECTURE.md` §7.3 |
| B3 | Screen-on pill can be tapped off for the current transfer only; it resets for the next session | PRD §5.10, `docs/ARCHITECTURE.md` §7.1 |
| B4 | Welcome action "Start sharing" | PRD §5.1 |
| B5 | Web navigation: bottom bar below 760 px, icon rail 760–1099 px, sidebar from 1100 px | PRD §4, `docs/DESIGN_SYSTEM.md` §4 |
| B6 | Sixth receiver auto-declined with a notice to the sender | PRD §5.3 |
| B7 | ETA shows "Estimating time…" until progress passes 3 % and while reconnecting | PRD §6.5 |
| B8 | Screen IDs (`home`, `send`, `send-review`, `session`, …) | `docs/UX_SCREEN_MAP.md` |
| B9 | A "Require approval" default in Settings › Transfer, in addition to the per-session switch | PRD §5.8: Settings holds the default for new sessions (off); each session can still switch it |
| B10 | Web layout breakpoints 760 px (rail) and 1100 px (sidebar) replace the generic `sm/md/lg/xl` list in the Phase 0 plan | `docs/DESIGN_SYSTEM.md` §4, `docs/phases/PHASE_0_FOUNDATION.md` |
| B11 | Screen-on pill with per-state copy ("Screen stays on", "Screen can sleep", "Screen-on is off in Settings", "…keep this tab visible") instead of the earlier status-row sentences | `docs/ARCHITECTURE.md` §7.3 |
| B12 | Receiver code-expired wording "Code expired — ask the sender for a new code" (`common.cx_rx`) and "Stored only on this device" (`common.local`) instead of the PRD's earlier sentences | PRD §5.4, §9 |
| B13 | Vietnamese pattern translations (`TRP`) become templates with `{1}` placeholders under `<app>_patterns` | `docs/DESIGN_SYSTEM.md` §1.2 |

## C. Accessibility notes on design values

| # | Observation | Mitigation |
|---|---|---|
| C1 | `border` and `border-strong` are below 3:1 against `surface` (WCAG 1.4.11 for component boundaries) | Controls never rely on the border alone: inputs carry a visible label and the `surface-2` fill, and focus shows a 2 px `focus` ring. Recorded in `docs/DESIGN_SYSTEM.md` §7 |
| C2 | `fg-3` is 4.3:1 on white | Used only for large or non-essential text; the token check enforces 3:1 for it and 4.5:1 for every other text token |
| C3 | The Brand page says "below 16 px drop the dots" but also shows a dotless favicon at exactly 16 px, while its browser-tab mock draws the dotted logo at 16 px | One rule: at 16 px and below use the dotless variant (16 px ICO entry, SVG favicon, `Logo` at size ≤ 16); dots from 17 px up |
| C4 | `send` text on `send-soft` is 4.4:1 (the Design System ghost hover state) | Text on `send-soft` uses `send-ink`; documented in `docs/DESIGN_SYSTEM.md` §7 |

## D. Open questions from the handoff and their answers

The Handoff Checklist lists open questions. Answers come from the PRD and the security model.

| Question | Answer |
|---|---|
| Security words: derived from the session key or display-only? Localized lists? | Derived by the server from the session and receiver device (`docs/SECURITY_MODEL.md` §3.1); one English word list on both ends so the words match across languages |
| No approval by default: is code + 10-minute expiry + rate limiting enough, or add "Lock session"? | Open join plus lockouts plus protected mode; "Stop accepting" is the lock (`docs/SECURITY_MODEL.md` §3) |
| Keep screen on: auto re-acquire after the tab or app returns? | Yes (`docs/ARCHITECTURE.md` §7.2) |
| iOS background for the cloud route | Evaluated in Phase 7/8; P2P still suspends (PRD §2) |
| Android `dataSync` limits on Android 15+ | ADR 0006; evaluated in Phase 6 |
| Web saving more than 4 GB outside Chromium | Capability check and honest refusal or app recommendation (ADR 0005, PRD §6.8) |
| Cloud pricing, who pays, currency | Signed-in sender's account; pricing is configuration (PRD §6.6); currency decided in Phase 8 |
| Clipboard retention enforcement | Both: server sweeper and client display (PRD §7.6) |
| History local only, sync later? | Local by default; encrypted cloud sync when signed in (PRD §2, Phase 5A) |
| Reconnect window before Failed | Decided in Phase 4 with the reconnect policy |
| Can a sender stop joining early; can an expired code value be reused? | Yes, Stop accepting; code values are unique among open join windows and may be reissued later (`docs/ARCHITECTURE.md` §8) |
| Does the session close when the last receiver finishes? | No; it stays until Close, idle expiry, or its maximum lifetime (`docs/SECURITY_MODEL.md` §6) |

## E. PRD elements the design does not show

These are required by the PRD or `CLAUDE.md` but have no design specimen. Each uses existing design components so it looks native, and its strings come from the hand-written `shared/i18n/product.json` (EN and VI), merged into the catalogs under `product`.

| # | Required element | Source of the requirement | Component used | Strings |
|---|---|---|---|---|
| E1 | **Block** a receiver (removes and refuses rejoin from the device and its IP /64), with a confirmation | PRD §5.3, `CLAUDE.md` §7 | Participant card action next to Remove (`user-x` icon family, `danger` ghost button), dialog | `product.block`, `block_confirm_h`, `block_confirm_p`, `blocked_rx` |
| E2 | **Stop accepting** and the nudge after the first join | PRD §5.3 | Ghost button on the session screen; inline banner | `product.stop_accepting`, `stop_nudge`, `not_accepting_rx` |
| E3 | Protected-mode notices for sender and receiver | `docs/SECURITY_MODEL.md` §3.1 | Warning banner (`warning-soft` / `warning-ink`) | `product.protected_mode`, `protected_mode_sender` |
| E4 | "Join within m:ss" in the last minute of the join window | PRD §5.4 | Caption under the preview's Receive button, stays calm (no red), like the sender countdown | `product.join_within` |
| E5 | Web wake lock **refused** state | PRD §5.10, `docs/ARCHITECTURE.md` §7.3 | Screen-on pill, same visual as the unsupported state | `product.wake_refused` |
| E6 | PRD §9 microcopy with no design source: "No account needed to send or receive files", "Waiting for the sender to let you in", "Sign in to use Cloud transfer" (the full list of required keys is the PRD §9 table) | PRD §9 | Welcome, receiver waiting screen, disabled Cloud option | `product.no_account`, `waiting_sender`, `cloud_signin` |
| E7 | Rate-limit wait message, identity bootstrap failure, reset device identity | PRD §5.1, §5.7, `docs/SECURITY_MODEL.md` §5 | Inline banner, Devices card, confirm dialog | `product.rate_limited`, `identity_offline`, `identity_failed`, `reset_identity`, `reset_identity_p`, `anon_since` |
| E8 | Session full for the receiver | PRD §5.4 | Error state on the preview | `product.session_full_rx` |
| E9 | Parameterized versions of design strings that only exist as samples or code ternaries: join toast, receiver slots, join-window countdown, "Choose where to save" | PRD §5.3, §5.4, §9 | Toast, Capacity, Share panel, preview CTA | `product.peer_joined`, `slots_left`, `code_expires_in`, `choose_save` |
| E10 | Clipboard sign-in prompt and the pill's platform hints | PRD §5.9, `docs/ARCHITECTURE.md` §7.3 | Account-required intro; text next to the keep-open banner | `product.sign_in_clipboard`, `hint_android_screen_off`, `hint_ios_lock` |
| E11 | Account-flow and lifecycle strings the design lacks: after-sign-in choices, add-device prompt for Clipboard, history-sync banner, sender's background join notification, iOS guest Cloud prompt, Cloud "cost unknown", parameterized connection-log lines, loading labels, capacity, email validation | PRD §2, §5.6, §5.9, §6.6, `docs/SECURITY_MODEL.md` §3.1, `docs/DESIGN_SYSTEM.md` §6b | AC-4 trust layout, account-required intro, History banner, local notification, Cloud option, connection-log drawer, Button, Capacity, Input | `product.add_device`, `copy_history`, `add_device_clipboard`, `turn_on_history_sync`, `peer_joined_receiving`, `ios_cloud_signin`, `cost_unknown`, `log_*`, `creating`, `joining`, `capacity`, `capacity_full`, `email_invalid` |
| E12 | Guest / Signed in peer badge text, Web connection-log lines the Web prototype has only in English (retry requested, Cloud approved, Cloud budget reached), the live "Sending to n receivers" label, and the Web clipboard fallback hint | PRD §5.3, §5.9, §9 | IdentityBadge, connection-log drawer, live-activity row | `product.badge_guest`, `badge_signed_in`, `log_retry_requested`, `log_cloud_approved`, `log_cloud_budget`, `live_sending_to`, `clipboard_click_sync` |
