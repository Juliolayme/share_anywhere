# QA — Phase 4

Independent review by the `qa-reviewer` agent (`.claude/agents/qa-reviewer.md`). The agent is read-only; the engineer applies fixes and the agent re-runs.

## Round 1 — commit 595be07 (code as 06e9211) — FAIL

1 P0, 1 P1, 10 P2 findings.

**What held up under review:**

- backend vet, lint and race tests with the database (no skips);
- 160 web unit tests, format, lint, type check, protocol, i18n and tokens checks;
- `history.spec.ts` and `multi.spec.ts` on chromium-desktop, and `five-receivers.spec.ts` locally;
- access levels and authorization of Block and Remove (sender only, under the session row lock);
- no account gates in Transfer or History.

Nightly [42913806192](https://github.com/Juliolayme/share_anywhere/actions/runs/42913806192) on 06e9211 passed every job, `five-receivers` included. On CI [42913806193](https://github.com/Juliolayme/share_anywhere/actions/runs/42913806193):

- backend, web, protocol, security, docs, compose and e2e-web (android-chrome) passed;
- the other four e2e jobs were cancelled by the next push.

**Why it failed:**

- the session aggregate ended a live session as soon as its join window closed after a delivery, which contradicted the PRD;
- the Web client's result disagreed with the server rule.

### Resolution of round 1 findings

| Finding | Severity | Resolution |
|---|---|---|
| A session that delivered something ended (COMPLETED/PARTIALLY_COMPLETED) as soon as its join window closed. This removed Create new code and ended the session before its lifetime (PRD §3 and §13, SECURITY_MODEL §3, UX_SCREEN_MAP TR-4) | P0 | Nothing ends a live session automatically except the idle or maximum lifetime; the sender's Close still records CLOSED.<br>When a lifetime ends the session, `EndStatus` records the delivery result: COMPLETED, PARTIALLY_COMPLETED, or EXPIRED when nothing was delivered.<br>The in-transaction settling (`Derive`, `settle`, `Settle`, `settleDue`) is removed.<br>New DB tests, after window expiry and after Stop accepting:<ul><li>the session stays ACTIVE;</li><li>Renew works;</li><li>a late receiver joins with the new code and completes.</li></ul>Further tests: idle end completed/partial/expired; removed and blocked excluded; max lifetime mid-transfer; Close; the lifetime end racing final reports. `docs/ARCHITECTURE.md` §4.5 rewritten (ac7a284) |
| The Web result counted removed and blocked receivers as a shortfall, unlike §4.5 | P1 | `finalOf`:<ul><li>removed and blocked receivers do not count;</li><li>a receiver that left counts with what it received.</li></ul>Unit tests added. `multi.spec` now asserts the sender's result is `completed` after Remove and after Block (546873f) |
| P2-1 `VITE_BLOCK_CACHE_MB` missing from `.env.example` and the image; small values disable caching | P2 | Added to both; clamped to at least one 4 MiB block; parsing tested |
| P2-2 Group ETA doc comment above the wrong function | P2 | Moved |
| P2-3 Sixth-join assertion too loose | P2 | Asserts `409 session_full` |
| P2-4 Fairness test not on a simulated clock | P2 | Kept on real timers (block hashing runs on WebCrypto promises that fake timers do not drive); reason recorded in TRANSFER_PROTOCOL §5.1 |
| P2-5 Phase file says "throttled via CDP" | P2 | TESTING_AND_CI records that the receiver write delay meets it in every engine (CDP does not throttle data channels) |
| P2-6 No test for the redial jitter | P2 | `redialDelay` extracted and tested (doubling, cap, ±25 % bounds, spread) |
| P2-7 Blocked looks removed; Block hidden after completion; confirmation unnamed | P2 | Blocked chip (`phrases.blocked`). Block offered while the receiver is still in the session, also after it finished. Confirmation titled "Block {name}?". G21 updated |
| P2-8 Report incomplete | P2 | QA record, CI links and commits added |
| P2-9 History drawer gaps | P2 | Files list recorded in G17. Sender entries record bytes per file. A partial send's integrity line stays `h_bad` (the design has no third string); recorded in G17 and the backlog |
| P2-10 Group ETA built from fragments | P2 | Single `product.bytes_of_eta` key (EN/VI) |

## Round 2 — commit 823e67e — FAIL

0 P0, 2 P1, 7 P2 findings. The round-1 P0 and P1 were confirmed resolved.

**Why it failed:**

- the sender's result and History entry stayed fixed at the first moment every receiver had ended, which the late-receiver flow allowed by the P0 fix made wrong;
- a guest hit the open-session cap after two sends, because finished sessions stay live while the tab is open.

### Resolution of round 2 findings

| Finding | Severity | Resolution |
|---|---|---|
| Sender result frozen at the first "everyone ended" moment: wrong for late receivers; removing the only (wrong) receiver wrote a "cancelled" result while the session waited; the screen was not held on TR-7 with the window open | P1 | `resultOf`: while the session is live the result is provisional. It shows once every receiver has ended and at least one counts, and clears when a late receiver joins; TR-6 then comes back.<br>The History entry (same id) is rewritten whenever the result changes, keeping its creation time.<br>TR-6/TR-7 keep the banner and the screen on while the window is open.<br>Unit tests cover `resultOf` and the late receiver with History rewrites. New e2e on three engines: a late receiver after the result brings back the dashboard and completes |
| Guest blocked after two sends: finished sessions stay live while the tab is open, filling the open-session cap | P1 | TR-7 "New transfer" closes the finished session first, confirming while the join window is open. Receivers that already have their files keep RX-7. e2e asserts the code is refused (`410 session_expired`) afterwards. "Back to the session" leads to the code and Create new code instead. ARCHITECTURE §4.5, G22 |
| P2-1 Lifetime end mid-transfer left cards transferring and the screen held | P2 | On SESSION_EXPIRED/CLOSED, receivers still going become cancelled and the result is final; unit test |
| P2-2 Close looked dead after a lifetime end | P2 | Close, Remove and Block hidden once the session has ended |
| P2-3 Phase 4 product keys missing from the E-table | P2 | E15 lists `transfer_offline`, `block_failed`, `block_confirm_named_h`, `bytes_of_eta`. About 150 older product keys from Phases 2–3 are also unlisted; recorded in the backlog |
| P2-4 Nightly evidence predates the final backend | P2 | Nightly re-run on the final commit and linked in the report |
| P2-5 Report overstated Create new code after delivery on Web | P2 | TR-6/TR-7 now link back to the session (the code and Create new code). The report states what is covered: backend DB tests for Renew after delivery, and the e2e late receiver through the open window |
| P2-6 Blocking a receiver that had finished flipped the result to cancelled | P2 | Server `EndStatus` and client `finalOf` count a removed or blocked receiver that had received every file as a delivery; table and exhaustive tests updated |
| P2-7 Fairness test on real timers | P2 | Accepted in round 1; documented |
