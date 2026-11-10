# Design deviations

Where the Claude Design handoff (`design/claude-design/`, imported in commit 089e59c) and the product documents disagree. `CLAUDE.md` sets the rule: the design is the UI source of truth, but a product decision in the PRD wins over the design. Each entry says which side wins and what the code does.

## A. Design elements not built because a PRD decision wins

| # | Design | PRD decision | What the code does | Revisit |
|---|---|---|---|---|
| A1 | Email verification with a six-digit code after sign-up (`verify` screen; `ve_*` strings) | No email verification in v1 (PRD §2 Authentication) | The `verify` screen is not built. Device trust is confirmed on the after-sign-in choices screen instead | Backlog: add verification later; strings are kept in the catalogs |
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

## C. Accessibility notes on design values

| # | Observation | Mitigation |
|---|---|---|
| C1 | `border` and `border-strong` are below 3:1 against `surface` (WCAG 1.4.11 for component boundaries) | Controls never rely on the border alone: inputs carry a visible label and the `surface-2` fill, and focus shows a 2 px `focus` ring. Recorded in `docs/DESIGN_SYSTEM.md` §7 |
| C2 | `fg-3` is 4.3:1 on white | Used only for large or non-essential text; the token check enforces 3:1 for it and 4.5:1 for every other text token |

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
