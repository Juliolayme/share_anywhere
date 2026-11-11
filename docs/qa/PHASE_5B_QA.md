# QA — Phase 5B (Clipboard Sync v1)

Independent review by the `qa-reviewer` agent (`.claude/agents/qa-reviewer.md`). The agent is read-only; the engineer applies fixes and the agent re-runs.

## CI history of the phase

- [43010037941](https://github.com/Juliolayme/share_anywhere/actions/runs/43010037941) on 063de1d (CI storage guard): every job green.
- [43012316305](https://github.com/Juliolayme/share_anywhere/actions/runs/43012316305) on b956f0f (clipboard backend): every job green.
- [43021399182](https://github.com/Juliolayme/share_anywhere/actions/runs/43021399182) on fab4866 (Web Clipboard): every job green, e2e first attempt in all five projects (chromium 69, firefox 67, webkit 68, android-chrome 61, ios-safari 61). Nightly [43021413838](https://github.com/Juliolayme/share_anywhere/actions/runs/43021413838) green; it produced the mobile snapshot baselines for the fifth tab, committed in de39866.

- [43025957764](https://github.com/Juliolayme/share_anywhere/actions/runs/43025957764) on 8d2cb0e (QA round 1 backend fixes): every job green.
- [43029093517](https://github.com/Juliolayme/share_anywhere/actions/runs/43029093517) on 726c0a2 (QA round 1 Web fixes): every job green, e2e first attempt in all five projects (chromium 69, firefox 67, webkit 68, android-chrome 61, ios-safari 61).
- [43040047354](https://github.com/Juliolayme/share_anywhere/actions/runs/43040047354) on 6ae4368 (QA round 2 fixes): backend, web, protocol, security, docs and compose green; `e2e-web (chromium-desktop)` and `(android-chrome)` failed while installing Playwright system packages (apt: "Some index files failed to download"), an infrastructure failure, not a test failure; the other e2e jobs were cancelled with them. Superseded by the round-3 fix push.
- [43052733954](https://github.com/Juliolayme/share_anywhere/actions/runs/43052733954) on 5e68063 (QA round 3 fixes): backend, web, protocol, security, docs and compose green. The e2e jobs failed or hung while installing Playwright system packages (apt: "Temporary failure resolving 'security.ubuntu.com'"). This was an infrastructure failure: no test ran. Superseded by the round-4 P2 push.
- [43058002672](https://github.com/Juliolayme/share_anywhere/actions/runs/43058002672) on 9aa7917 (Playwright dependency install retried in CI): non-e2e jobs green; e2e jobs cancelled by the next push while the runners' apt mirrors were still failing.
- [43062069105](https://github.com/Juliolayme/share_anywhere/actions/runs/43062069105) on fbfe47f (QA round 4 P2s, final): every job green, e2e first attempt in all five projects (chromium 70, firefox 67, webkit 68, android-chrome 61, ios-safari 61), no test retried. This is the commit tagged `clipboard-protocol-v1`.

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

## Round 3 — commit 6ae4368 — FAIL

0 P0, 1 P1 and 6 P2 findings.

Every command passed: Web, root, backend (including `-race`), lint and govulncheck. The clipboard and account e2e suites passed in all five projects.

**What held up under review:**

- The round-2 P1 is fixed. QA's corrected harness reruns the race scenarios with a working store, and they keep server rows live.
- The other round-2 resolutions are verified: offline deletes, presence ordering, `Close`, the drop counter, timestamps, docs, and the golden vector.
- No regressions from round 1.
- The single-tab engine had no lost, duplicated, ghost or wrongly deleted path in any scenario QA tried.

**Why it failed:**

- **P1-1:** every tab keeps its own timeline in memory, but each pass started from the cursor shared in IndexedDB, which other tabs move. A tab that another tab had already pulled for (for example a suspended background tab) missed new events and kept showing deleted ones until a reload. The ack path could also write a ghost row into the shared cache after another tab had deleted or tombstoned it. QA reproduced this in its unit harness and live on the stack.

### Resolution of round 3 findings

| Finding | Severity | Resolution |
|---|---|---|
| Per-tab timelines share one stored cursor; ghosts written by late acks | P1 | Each engine keeps its own applied cursor. The cache and the cursor are persisted together, and the stored cursor only moves forward. An ack for an event another tab has taken or tombstoned resyncs instead of writing the row. QA's T1–T4 are regression tests, plus a live multi-tab spec |
| Clear misses captures queued in another tab | P2 | Clear reads the shared queue |
| A capture made while Clear waits is dropped | P2 | The queue is snapshotted before the wait, so later captures are kept and sent |
| Cross-tab ghost during a create in flight | P2 | Covered by the P1 fix and its test |
| ARCHITECTURE presence sentence | P2 | Corrected: presence runs after WELCOME |
| Misplaced test doc comment | P2 | Fixed |
| Report i18n count | P2 | Fixed |

Verification note (engineer, before the round 3 fix commit): the Web unit suite failed one test in the first of 24 local runs. The failing test was not captured, and the next 23 runs (6 of them under CPU load) all passed, so the cause is unknown. QA round 4 is asked to run the suite repeatedly to catch it.

## Round 4 — commit 5e68063 — PASS

0 P0, 0 P1 and 6 P2 findings. The pass was conditional on CI, whose e2e jobs had not run because of the apt failure above.

Every command passed:

- the Web unit suite in 20 of 20 runs, 8 of them under concurrent load (the earlier one-in-24 failure did not reproduce);
- backend, lint and govulncheck;
- the clipboard and account e2e suites in all five projects;
- `tabs.spec.ts` 6 of 6.

The round-3 harness passed 15 of 15. A new multi-tab fuzz (3 tabs plus a phone, random latency) found no duplicates, no wrongful deletes and no lost captures in 500 seeds without Clear. Its only failures were the P2-1 and P2-4 races below. Earlier rounds did not regress.

### Resolution of round 4 findings (after the PASS)

| Finding | Severity | Resolution |
|---|---|---|
| Clear can drop an event pulled while the clear request runs | P2 | The ids to remove are snapshotted when Clear is pressed; regression test N1 |
| A tombstone pulled while `ackCreate` runs leaves a ghost in that tab | P2 | `tombstoned` and `deletedHere` are re-checked after the await, and a resync runs when the acked seq is beyond the cursor; test N2 |
| A first send answered with a tombstone seq beyond the cursor shows the row until the next pull | P2 | A refresh is scheduled after such an ack; documented; test N3 |
| A capture made during `adopt()` is dropped and reported as synced | P2 | The drop list is built without the race; `synced` only for server-acknowledged captures; test N4 |
| CLIPBOARD_PROTOCOL §2.9 claims more than the code does | P2 | Wording matches the guarantees, including the 6-day history reload |
| Report and QA log out of date | P2 | Counts, skips, hashes and CI entries updated |

## Exit gate

- QA round 4 passed (0 P0, 0 P1). Its P2s are fixed in fbfe47f.
- CI 43062069105 on fbfe47f is green with no retries.
- The annotated tag `clipboard-protocol-v1` was created on fbfe47f. The session's git proxy refused to push the tag (branch pushes work, tag pushes are cut off), so the owner pushes it with `git push origin clipboard-protocol-v1` from a clone that has it, or creates the same tag on fbfe47f in GitHub.
