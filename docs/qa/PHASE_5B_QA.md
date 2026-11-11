# QA — Phase 5B (Clipboard Sync v1)

Independent review by the `qa-reviewer` agent (`.claude/agents/qa-reviewer.md`). The agent is read-only; the engineer applies fixes and the agent re-runs.

## CI history of the phase

- [43010037941](https://github.com/Juliolayme/share_anywhere/actions/runs/43010037941) on 063de1d (CI storage guard): every job green.
- [43012316305](https://github.com/Juliolayme/share_anywhere/actions/runs/43012316305) on b956f0f (clipboard backend): every job green.
- [43021399182](https://github.com/Juliolayme/share_anywhere/actions/runs/43021399182) on fab4866 (Web Clipboard): every job green, e2e first attempt in all five projects (chromium 69, firefox 67, webkit 68, android-chrome 61, ios-safari 61). Nightly [43021413838](https://github.com/Juliolayme/share_anywhere/actions/runs/43021413838) green; it produced the mobile snapshot baselines for the fifth tab, committed in de39866.

- [43025957764](https://github.com/Juliolayme/share_anywhere/actions/runs/43025957764) on 8d2cb0e (QA round 1 backend fixes): every job green.
- [43029093517](https://github.com/Juliolayme/share_anywhere/actions/runs/43029093517) on 726c0a2 (QA round 1 Web fixes): every job green, e2e first attempt in all five projects (chromium 69, firefox 67, webkit 68, android-chrome 61, ios-safari 61).

## Round 1 — commit fab4866 — FAIL

0 P0, 2 P1 and 13 P2 findings.

Every command passed. The clipboard and account e2e suites passed in all five projects; the one local Firefox failure was a Phase 5A spec on the local Firefox binary, and the same spec passes in CI. Live probes found no errors or deadlocks under concurrent mixed writes, and cursor walks matched history.

**What held up under review:**

- `account+device` on every route;
- `seq` ordering, with no `seq` reused after the sweep;
- idempotency, tombstones, the current-key-version rule, pause, size limits, the 100-item cap and the retention sweep;
- rate limits;
- the session re-check after the lock;
- cursor handling and cleanup when a device leaves;
- WebSocket messages carry metadata only and reach added, live devices only;
- lock order;
- zero clipboard API calls for guests, by construction and in e2e;
- every CB screen, with honest capture status and no polling;
- the offline queue holds ciphertext only, and data is wiped on sign-out;
- the AAD and locked rows;
- the storage guard;
- EN/VI strings and tokens.

**Why it failed:**

- **P1-1:** the exit-gate tag `clipboard-protocol-v1` did not exist.
- **P1-2:** the frozen protocol did not fix the text form of `event_id` and `entry_id`, although that text is part of the AAD and the server returns it in lowercase. A client that encrypted with an uppercase UUID (iOS `UUID().uuidString` is uppercase) would produce events every device shows as locked. QA reproduced this live.

### Resolution of round 1 findings

| Finding | Severity | Resolution |
|---|---|---|
| Missing tag `clipboard-protocol-v1` | P1 | The annotated tag is created at the commit that passes QA and pushed with it. It is recorded in the report §9 and in this log |
| Text form of `event_id` and `entry_id` not fixed | P1 | Lowercase canonical 8-4-4-4-12 is required in CLIPBOARD_PROTOCOL §1.3 and §2.1–§2.2 and in OpenAPI patterns. The server rejects other forms with 400 for clipboard and history. Go and Vitest tests added |
| Sweep can deadlock with Clear history | P2 | The sweep deletes in bounded, ordered batches with `FOR UPDATE SKIP LOCKED`; Clear locks rows in `seq` order. Concurrency test added |
| Deleted event can come back from the offline queue | P2 | A tombstone removes the queued item; test added |
| `payload_size` described as uncheckable | P2 | The server enforces `len(ciphertext) == payload_size + 16`; the protocol states it |
| In-page copy capture contradicts the status panel | P2 | In-page copies are captured only when automatic capture is allowed |
| Offline first load shows an empty state | P2 | Shows the offline or error state instead |
| Queued toast blames being offline for every cause | P2 | The toast names the real cause |
| Touch targets under 44 px | P2 | Raised to 44 px |
| Another tab can write after a wipe | P2 | Wipe generation kept in IndexedDB and checked on every write |
| ARCHITECTURE locking wording | P2 | Corrected |
| Report gaps | P2 | This log, CI links, commit hashes and the tag plan added |
| Reads not rate-limited | P2 | Per-device read limit |
| Presence query delays WELCOME | P2 | Presence runs after WELCOME |
| `choices.spec.ts` navigates twice | P2 | Single navigation |

## Round 2 — commit 726c0a2 — FAIL

0 P0, 1 P1 and 7 P2 findings.

Every command passed. `TestClearRacingSweep` passed 25 times, plus 5 more under `-race`. The clipboard and account e2e suites passed in all five projects; the one local WebKit failure was a browser internal error on navigation, and it passed 3 of 3 on rerun. Live probes confirmed the canonical-id and size rules, and found no errors under a burst of mixed writes.

All 15 round-1 resolutions hold. Changing the history id formatting keeps every existing id (5,000 derived ids compared, 0 differences).

**Why it failed:**

- **P1-1:** the round-1 late-ack fix treated "no longer queued" as "deleted here" and re-sent a DELETE. A cursor pull also removes an event from the queue when it sees the event live, and the server sends `CLIPBOARD_EVENT_CREATED` before the 201, so the pull can win the race. When it did, a correctly synced item was deleted on every device. QA reproduced this with the repo's fake server, including three queued items flushed after a reconnect.

### Resolution of round 2 findings

| Finding | Severity | Resolution |
|---|---|---|
| A late create ack deletes a synced item | P1 | Local deletions are recorded explicitly, in a durable pending-delete list, and only those re-send DELETE. An ack for an event a pull already acknowledged is a plain success. Regression tests come from QA's harness |
| Deleting a queued item while offline brings it back | P2 | Pending deletes are kept in IndexedDB and retried with the queue until 204 or 404 |
| Clear history keeps queued items | P2 | Clear also drops the queue |
| Presence workers: no shutdown, cross-socket ordering, silent drops | P2 | Stop path for the workers, ordering preserved per device, drops logged and counted; tests added |
| Timestamp precision differs between create and read | P2 | Rounded to microseconds before insert |
| Docs: read limit in §2.6, a sentence break, WS `event_id` pattern | P2 | Fixed |
| Report and QA log hashes and CI | P2 | Added |
| No golden vector for `entryUuid` | P2 | Golden vector test added |
