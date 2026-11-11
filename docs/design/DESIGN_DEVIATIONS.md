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
| C5 | Web header language and theme buttons are 40 px tall | 44 px (the `touch-target` token), so every control meets the 44 px touch-target rule the Phase 1 mobile tests assert |

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
| E13 | Web shell labels the design writes inline or does not have: landmark and step labels, digit labels, status pill, loading, link and code validation, rename and reset feedback, storage blocked, language names, version line, not-found page, skip link | `CLAUDE.md` §3 (accessible, no hard-coded strings), PRD §5.1, §5.6–§5.8 | Shell, Receive, Devices, History, Settings | `product.wl_receivers_h`, `wl_receivers_p`, `sidebar_guest_p`, `online_ready`, `identity_loading`, `this_browser_guest`, `step_choose`, `step_share`, `steps`, `nav_main`, `files_count`, `files_count_one`, `over_limit`, `remove_file`, `open_link`, `scan_hint`, `code_incomplete`, `link_invalid`, `digit_label`, `retry_in`, `reset_done`, `rename_failed`, `name_invalid`, `history_unavailable`, `version_web`, `lang_en`, `lang_vi`, `skip_to_content`, `not_found_h`, `back_home`, `filter_status`, `filter_date`, `filter_device`, `clear_failed` |
| E14 | History (HI-1, HI-2) labels the Web design writes inline (detail "Original size", "Route", "Duration", the "+ 2 files" title) or does not have (route value for a mixed route, failed delete, result count for screen readers) | PRD §5.6, `CLAUDE.md` §3 (accessible, no hard-coded strings) | History row, History detail drawer, Toast, live region | `product.history_title_more`, `history_title_more_one`, `history_original_size`, `history_route`, `history_route_mixed`, `history_duration`, `history_delete_failed`, `history_results`, `history_results_one` |
| E15 | Several-receiver dashboard strings the design lacks: a receiver out of contact, a failed Block, the Block confirmation with the receiver's name, the overall line with the group ETA | PRD §5.5, §6.5 | TR-6 receiver card, Block dialog, overall line | `product.transfer_offline`, `block_failed`, `block_confirm_named_h`, `bytes_of_eta`, `tx_other_tab` (another tab of the browser sends the files) |
| E16 | Open-sessions recovery panel on the send screen when Create hits the open-session cap (`409 too_many_open_sessions`): the device's open sessions with title, start time, receivers and code state, each with Open and Close (Close reuses the session screen's confirmation) | `docs/SECURITY_MODEL.md` §5 (open-session cap), `docs/API.md` §2.2 (`GET /v1/sessions`), `CLAUDE.md` §3 (no dead ends) | Card under the file list on `send-review`, list rows like the file list (`send-soft` icon tile, `secondary` Open and `danger-ghost` Close small buttons), inline loading, empty and error states | `product.open_sessions_h`, `open_sessions_p`, `open_sessions_loading`, `open_sessions_error`, `open_sessions_empty`, `open_session_started`, `open_session_receivers`, `open_session_window_open`, `open_session_window_expired`, `open_session_window_full`, `open_session_open_named`, `open_session_close_named`, `open_session_closed` |

## F. Design elements held back by phase or because they would show fake data

The design shows the finished product with sample data. These elements are left out until the phase that makes them real, so no screen carries a dead button or invented values (`CLAUDE.md` §3, §8b).

| # | Design element | Status in the code | Returns in |
|---|---|---|---|
| F1 | Welcome: sign-in and create-account links, the Clipboard Sync feature row, and `web_vv.k36` ("You can sign in later…") | Hidden while the `accounts` flag is off; the card shows `product.no_account` instead | Phase 5A |
| F2 | Sidebar and header Sign in buttons, rail sign-in icon, Devices "Sync your device list" card, Home "Sign in to see your other devices" | Hidden while `accounts` is off; the sidebar keeps the Guest panel without its button | Phase 5A |
| F3 | Home "Connection — Network is good · Direct P2P" card | Not built: Phase 1 has no network probe, so the values would be invented | Phase 3/4 (route probe) |
| F4 | Send screen "Use sample files (demo)" and the receive screen's demo-code hint (`common.cx_hint`) | Not built (prototype-only aids) | — |
| F5 | Create share session button, Require approval switch on the send review, Continue and "Open link" on Receive, and the QR scan hint (`product.scan_hint`, which needs the `/j/<token>` route) | Hidden while the `sharing` flag is off. The file picker works, the code is validated inline when focus leaves an incomplete code, and a pasted link is validated on blur | Phase 2 |
| F6 | Settings sections Transfer, Notifications, Data, Clipboard; Account menu (profile, security, sign out) | Not shown until the feature each one controls exists | Phases 2, 3, 5A, 5B |
| F7 | Settings "Licenses" link | Not shown until a licenses page exists | Phase 9 |
| F8 | History rows open a detail view | **Built in Phase 4**: rows open the HI-2 drawer at `/history/:entryId` (see G16–G19) | — |
| F9 | Session screen "Start transfer" / "Open dashboard", the transfer dashboard, and per-receiver progress | **Built in Phase 3**: each joined receiver's card shows its transfer, "View transfers" opens TR-6 (transfers start when the receiver picks a save location, PRD §5.4, so there is no "Start transfer" button) | — |
| F10 | Security words shown once in the share panel ("receivers see the same: maple · river · seven") | Words are derived per receiver device (`docs/SECURITY_MODEL.md` §3.1), so they appear on each participant card and on the receiver's screen, not in the share panel | — |
| F11 | Demo controls: "Demo: expire now", "Simulate a join request" | Not built; the test stack's clock hook covers expiry in e2e | — |
| F12 | Receive save location (RX-5b, `receive-save`) and "You're approved — Choose save location" | **Built in Phase 3** (see G1–G2, G5) | — |
| F13 | Sender notice when a sixth receiver was auto-declined (B6) | The server refuses the sixth join (`409 session_full`, receiver sees `product.session_full_rx`) and the sender sees "5/5 · Session full"; a per-attempt notice to the sender is backlog | Phase 4 |
| F14 | The design has no screen for a receiver who joined while transfers do not exist yet, nor for a sender's ended session | `receive-joined` (RX-4b) was removed in Phase 3: a joined receiver goes to `receive-save`. `session-ended` (TR-4b) stays for a closed or expired session with no transfer result | — |

## G. Web transfer screens: differences from the design (Phase 3)

| # | Design | Built | Why |
|---|---|---|---|
| G1 | RX-5b "Save to a folder — writes straight to disk as it arrives" | Blocks are staged in the Origin Private File System as they arrive and each file is copied into the chosen folder as soon as it passes the whole-file SHA-256 check; the option text says so (`product.save_folder_p`) | File System Access writable streams keep data in a swap file until `close()`, so a reload would lose verified blocks and break resume; reopening with `keepExistingData` copies the whole file each time (`docs/TRANSFER_PROTOCOL.md` §4) |
| G2 | RX-5b "Browser download — Uses the Downloads folder" with "Not reliable for files over 4 GB" | "Keep in this browser, then download": OPFS storage that survives a reload, then a Download button per file; "Keep in memory" appears only where OPFS is unavailable (private windows), capped at 256 MB | The phase forbids in-memory receiving above 256 MB; a disk-backed OPFS file downloads without being loaded into memory |
| G3 | RX-7 "Open" per file and "Show in folder" | Download per file (browser storage) or "Saved in “folder”" (folder mode) | A web page cannot open files with other apps or reveal folders |
| G4 | TR-6 "Retry" for a failed receiver and the Cloud budget state | Pause, Resume, Details, Remove; Retry and Cloud are not shown | A failed transfer record is terminal (`docs/ARCHITECTURE.md` §4.5); retrying needs new records (Phase 4 backlog). Cloud is Phase 8 |
| G5 | RX-5b note "Supported in this browser (Chrome 130)" | A "What this browser can do" table with the detected row of PRD §6.8 (folder, browser storage with free space, background behavior) plus warnings (iOS keep open, mobile background, large files on iOS, low or no storage) | PRD §5.4 and §6.8: capability limits are detected and explained before the transfer starts |
| G6 | RX-6 header always shows "Connected directly" | The route chip appears once the selected ICE pair is known (Direct or Relay) | No invented values |
| G7 | RX-5b has no security words | The receiver's security words are shown above the save options | They must be comparable with the sender's screen before files arrive (`docs/SECURITY_MODEL.md` §3.1) |
| G8 | TR-6 sub-heading "Session 482 913 · 3 files · 11.54 GB" | "3 files · 11.54 GB" | The code is a short-lived secret that expires or is replaced while transfers continue (`docs/SECURITY_MODEL.md` §3); the dashboard does not repeat it |
| G9 | TR-6 receiver route chip "Direct P2P" | "Connected directly" / "Using relay" (`handoff.p2p`, `handoff.relay`), the same chip as RX-6 (colors and icons as the Design System route badge); the chip is hidden while (re)connecting instead of showing the design's "Finding route…" probe badge | PRD §9 names these catalog phrases for the route; one wording on every screen |
| G10 | RX-6 has no Details button and no security words | Details opens the connection log (as TR-6 does), and the security words stay visible | PRD §9 lists the details drawer for active transfers; words stay comparable while files arrive (`docs/SECURITY_MODEL.md` §3.1) |
| G12 | RX-7 “1 file failed the integrity check” with “Download this file again” for that file while the other files are kept | A whole-file SHA-256 mismatch (after every block passed its own hash and NACKed blocks were re-sent up to 3 times) ends the receive: files already verified stay (result “partial”, per-file Download), the failed file is marked failed, and the message is `product.tx_err_checksum`; no per-file retry button | A FAILED transfer record is terminal (`docs/ARCHITECTURE.md` §4.5), so downloading one file again needs a new record, the same work as G4 (Phase 4 backlog). The design strings name sample files (`web_xx.sum_p`) and have no parameters to reuse |
| G13 | RX-6 shows Pause whenever the transfer is not paused, including while verifying | Pause is not offered while verifying (the SHA-256 banner shows instead) | Every byte has arrived and only the local hash check remains; a pause would only leave the record `PAUSED` (`docs/TRANSFER_PROTOCOL.md` §7, `docs/ARCHITECTURE.md` §4.5) |
| G14 | TR-5 / TR-6 chips have no state for a receiver that dropped and did not come back | “Offline” chip and “Lost contact. They can reconnect while this page stays open” after the 10-minute reconnect window; its matrix cells turn grey like its card bar | The sender must not hold the screen on forever, and “Waiting for the receiver to choose where to save” would be untrue (`docs/TRANSFER_PROTOCOL.md` §6) |
| G15 | TR-5 participant card (and the TR-6 receiver card) show `approved` for a joined receiver | A “Waiting” chip and “Waiting for the receiver to choose where to save” until the receiver starts | With open join there is no approval step to report; the card says what the sender is waiting for (PRD open join, `docs/UX_SCREEN_MAP.md` TR-5) |
| G16 | History drawer "Send again" (Web, Android, iOS) | Not shown; the drawer offers Delete from history (`web_xx.h_del`, as the Android and iOS drawers do, and HI-2 in `docs/UX_SCREEN_MAP.md`) | A web page keeps no access to files after the transfer, so the button could not resend the same files; a button that only opened an empty picker would be misleading (`CLAUDE.md` §3, no dead buttons) |
| G17 | History drawer always shows Route, Duration and "SHA-256 checked" | Route and Duration appear only when the entry recorded them (optional `route`, `startedAt`); Integrity says `web_xx.h_ok` for a completed transfer and `web_xx.h_bad` otherwise; Transferred shows "—" when an older entry recorded no byte count; a Files list (name, size, bytes transferred) follows the summary, as UX_SCREEN_MAP HI-2 allows; a partial send shows `h_bad` even when some receivers verified (the design has no third integrity string) | No invented values: entries written before Phase 4 lack these fields, and only a completed transfer passed the whole-file check |
| G18 | History date filter offers Last 30 days / Last 7 days / Today, Last 30 days first | "All" (`common.f_all`) first and selected by default, then the design's three presets | Retention can be 90 days (Settings), so a 30-day default would hide entries the user chose to keep |
| G19 | History detail is a drawer over the list with no URL of its own | The same drawer, opened at `/history/:entryId` (HI-2) so the entry can be linked and Back closes it; the list keeps its filters underneath, Escape and the scrim close it, and focus returns to the row | `docs/UX_SCREEN_MAP.md` HI-2 route; keyboard and screen-reader support (`CLAUDE.md` §3) |
| G20 | TR-6 overall line shows only “{done} of {total} delivered” | The overall line adds the group ETA (“· 2 min left”, or “Estimating time…”) while any receiver is active | PRD §6.5: the group ETA follows the slowest active receiver |
| G21 | TR-6 receiver card offers Pause/Resume, Details and Remove | Block is offered next to Remove (with the TR-5 confirmation, titled with the receiver's name) while the receiver is still in the session, including after it finished; a blocked receiver's card shows a "Blocked" chip (`phrases.blocked`, Ban icon) instead of "Removed" | PRD §5.5 lists Block per receiver on the dashboard; open join makes it the sender's main safety control |
| G22 | TR-7 shows the result with "View history" and "New transfer" links; the header keeps Close | While the session is still live, the result is provisional: a receiver who joins later (window still open, or Create new code) brings back TR-6, and the History entry is rewritten when the result changes. TR-6/TR-7 keep the keep-open banner and the screen on while the join window is open, offer "Back to the session" (`product.back_to_session`) to reach the code and Create new code, and "New transfer" closes the finished session first (with the Close confirmation while the window is open). Once the session has ended, Close, Remove and Block are hidden | A delivered session stays live until Close or its lifetime (`docs/ARCHITECTURE.md` §4.5): late receivers are supported, the keep-screen-on rule covers an open window (§7.1), and a guest's open-session cap (`docs/SECURITY_MODEL.md` §5) must not fill with finished sessions |
