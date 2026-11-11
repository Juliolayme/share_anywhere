# QA — Phase 5A (accounts, device linking, Devices list, cloud history)

Independent review by the `qa-reviewer` agent (`.claude/agents/qa-reviewer.md`). The agent is read-only; the engineer applies fixes and the agent re-runs.

## CI history of the phase

- [42947804008](https://github.com/Juliolayme/share_anywhere/actions/runs/42947804008) on 734d716: every job green, e2e first attempt in all five projects (guest flows on the new backend).
- The `security` job (gitleaks) failed on a598989 and 96575ba: published protocol test vectors and a type field were flagged. Fixed in 734d716 (fingerprints plus a path allowlist).
- [42961740565](https://github.com/Juliolayme/share_anywhere/actions/runs/42961740565) on e3289ba: backend, web, protocol, docs, compose and e2e-web in all five projects passed with no retries (account suite included); `security` failed on a new Go advisory, GO-2026-6859 (net/http, fixed in go1.27.4). Fixed in 5fdffe0 (toolchain go1.27.4).
- [42962832188](https://github.com/Juliolayme/share_anywhere/actions/runs/42962832188) on 5fdffe0: every job green, `security` included. One WebKit test (`p2p.spec.ts` reconnect) passed on retry: it waited only the default 5 s for the first verified block. 3987ac8 gives it 30 s like the other specs in the file.
- [42967732687](https://github.com/Juliolayme/share_anywhere/actions/runs/42967732687) on 4446bee (QA round 1 fixes): every job green, e2e first attempt in all five projects (chromium 63, firefox 62, webkit 63, android-chrome 56, ios-safari 56).
- [42974283806](https://github.com/Juliolayme/share_anywhere/actions/runs/42974283806) on f585651 (QA round 2 fixes): every job green, e2e first attempt in all five projects (chromium 64, firefox 63, webkit 64, android-chrome 57, ios-safari 57).
- [42980800030](https://github.com/Juliolayme/share_anywhere/actions/runs/42980800030) on 79f6446 (QA round 3 fixes): every job green, e2e first attempt in all five projects (chromium 64, firefox 63, webkit 64, android-chrome 57, ios-safari 57).
- [42984689531](https://github.com/Juliolayme/share_anywhere/actions/runs/42984689531) on 7fa9f27 (QA round 4 fixes): every job green, e2e first attempt in all five projects (chromium 64, firefox 63, webkit 64, android-chrome 57, ios-safari 57).
- [42989102231](https://github.com/Juliolayme/share_anywhere/actions/runs/42989102231) on dd0df12 (QA round 5 fixes): every job green, but ios-safari passed one test on retry. On the first attempt, `account/signin-during-transfer.spec.ts` saw no verified block of the paced second transfer within 30 s, although both peers reported the connection as connected (before any sign-in). Under investigation (diagnostics for data-channel open and the first block to be added).
- [42997152648](https://github.com/Juliolayme/share_anywhere/actions/runs/42997152648) on e41e6d3 (QA round 6 fixes): every job green, e2e first attempt in all five projects (chromium 64, firefox 63, webkit 64, android-chrome 57, ios-safari 57).
- [43003792138](https://github.com/Juliolayme/share_anywhere/actions/runs/43003792138) on 9b76992 (QA round 7 fixes): every job green, e2e first attempt in all five projects (chromium 64, firefox 63, webkit 64, android-chrome 57, ios-safari 57); nightly 43003792203 green.
- Nightly [42961754657](https://github.com/Juliolayme/share_anywhere/actions/runs/42961754657) on e3289ba: every job passed. It generated the new mobile snapshot baselines (header Sign in chip), committed in 9874e3f.

## Round 1 — commit e3289ba — FAIL

2 P0, 2 P1, 9 P2 findings.

**What held up under review:**

- format, lint, type check, 269 web unit tests, build (main JS 112,833 bytes gzip), protocol, i18n, tokens and Markdown checks;
- backend tests with PostgreSQL (no skips), golangci-lint;
- the account suite, 16 tests in each of the five projects;
- access levels enforced from the OpenAPI table;
- memory-only access tokens and the retry rule;
- the refresh grace window's core rules;
- `returnTo` validation;
- password reset (no enumeration, single use, token removed from the URL);
- non-extractable key storage and wipe;
- history encryption AAD and `seq` ordering;
- pairing code handling;
- guest-first;
- the `clipboard` flag stays off.

**Why it failed:**

- **P0-1:** key rotations were not authenticated. Any added device, including one that knows only the password, could post a rotation with an ADK it chose, and every device accepted any rotation blob it could open. Device wrapping keys were also registered before the device held the ADK, so later rotations wrapped new keys to unpaired devices. The server half was reproduced live.
- **P0-2:** the required `security` check was red on the new Go advisory.

### Resolution of round 1 findings

| Finding | Severity | Resolution |
|---|---|---|
| Unauthenticated key rotation and unproven device keys | P0 | Key authenticity (ADR 0012, `docs/CLIPBOARD_PROTOCOL.md` §1): a per-version Ed25519 key derived from the ADK; rotations signed with the previous version and verified by the server; device keys registered only with a proof made with the ADK; clients verify the chain link and verify key on pickup, wrap only to proven keys, and check recovery against a phrase-derived anchor. Tests for the QA attack and each rule |
| `security` red on GO-2026-6859 | P0 | Toolchain go1.27.4 (5fdffe0); govulncheck reports nothing reachable |
| Not-added Web session persisted past the browser session (PRD §2) | P1 | `sa_acct` browser-session cookie bound to the not-added session (ADR 0013); without it the refresh ends the session |
| History "Syncing…" forever when the key check fails | P1 | Error banner with Retry, checking state, correct setup and pair links |
| A retired refresh secret could re-enter the grace window | P2 | Retired secrets are always reuse (ADR 0013); test added |
| Sign-out replacement identities bypass the creation limit | P2 | Documented in SECURITY_MODEL §5 with its bound (sign-in limits) |
| A not-added session can rename devices and toggle sync | P2 | `PATCH /v1/devices/{id}` and `PATCH /v1/me` are `account+device`; the UI hides the controls |
| SMTP errors may log the address | P2 | Fixed message plus error class |
| Panic log path unredacted | P2 | Uses `RedactPath` |
| Sign-in copy mentions Clipboard Sync | P2 | Recorded in DESIGN_DEVIATIONS (5B delivers it) |
| History banner offline at load and setup link | P2 | Fixed |
| Report gaps | P2 | Report §4 and §9 completed; CI history listed here |
| Unreadable history entries never retried | P2 | Lowest skipped `seq` remembered; pulled again when new key versions arrive |

## Round 2 — commit 4446bee — FAIL

0 P0, 2 P1, 6 P2 findings. Every command, the backend and Web suites, and the account e2e suite (18 tests in each of the five projects) passed. Every round-1 finding was verified fixed or documented, with the report gaps only partly fixed.

**What held up under review:**

- the password-only attacker can no longer rotate, register a key or wrap a pairing blob;
- pending pickup requires the chain link to the held ADK and a matching verify key;
- recovery is anchored to the phrase;
- messages are domain-separated, comparisons constant-time, Ed25519 strict;
- the `sa_acct` binding, retired secrets, `account+device` PATCH routes and log redaction were verified live;
- history sync with the retry rewind;
- guest-first, flags, i18n and tokens.

**Why it failed:**

- **P1-A:** device keys could be proven with an old ADK version. A device revoked after holding ADK(v1) that keeps it and knows the password could re-register with a v1 proof, and the owner's next rotation wrapped the new ADK to it (reproduced live).
- **P1-B:** pairing on a device that already holds keys was checked only against the server's version list, and a dishonest server could steer any device into it (including by reporting `key_version 0`, which wiped local keys). The documented limitation was scoped too narrowly.

### Resolution of round 2 findings

| Finding | Severity | Resolution |
|---|---|---|
| Old-version device proofs (P1-A) | P1 | Registration requires the current version (`409 key_version_conflict`); rotation wraps exactly the devices proven at the current version (`devices_changed` with `missing`/`unexpected`); clients re-prove after every new version and exclude the device just revoked (ADR 0014) |
| Pairing not anchored on held keys; silent wipe (P1-B) | P1 | Pairing checks every held version's verify key, the signature chain from the highest held version and the chain back to it; a server report of version 0 or below the held version keeps the keys and shows the key problem state; the limitation is rescoped to a device holding no ADK |
| Rotation after revoke not durable | P2 | `rotation_due` set on the server whenever a device with a registered key leaves the account; ready devices rotate on their next key check |
| "Rejected" copy for this device's own refusals | P2 | Separate `refused` state and message |
| XSS claim overstated | P2 | Docs state that in-origin script can read raw ADK bytes while it runs |
| History banner disappears when `/v1/me` fails | P2 | Error with Retry; no "Syncing…" without a history store |
| Legacy keys are a dead end | P2 | Kept as documented (pre-release data only) |
| Report gaps | P2 | Report §4 and §9 completed with commit hashes and CI links |

## Round 3 — commit f585651 — FAIL

1 P0, 0 P1, 8 P2 findings. Every command, the backend and Web suites, and the account e2e suite (19 tests in each of the five projects) passed. Every round-2 finding was verified fixed. The round-2 attack scripts are blocked, live and in unit tests.

**What held up under review:**

- Old-version proofs refused, and rotations wrap exactly the devices proven at the current version.
- `rotation_due` is set on departure and cleared by rotation.
- Pairing and recovery are anchored on held keys, with no rollback or wipe.
- Pending pickup is verified.
- History banner states, guest-first, flags, i18n and tokens hold.
- No round-1 regressions.

**Why it failed:**

- **P0-1:** rotations wrapped the new ADK to the recovery public key from `GET /v1/keys`, which nothing authenticated. With the automatic owed rotation, a dishonest or write-compromised server could substitute its own key and obtain every new ADK with no user action. QA proved this against the client code with a stub server.

### Resolution of round 3 findings

| Finding | Severity | Resolution |
|---|---|---|
| Unauthenticated recovery public key in rotations | P0 | Setup signs the recovery public key with ADK(1)'s signing key (`recovery_key_signature`). A rotating device verifies it with its own verify_key(1) and otherwise refuses to rotate. Recovery checks it too. Vectors and tests added (ADR 0015) |
| Left-behind device shows "refused" | P2 | A repeated conflict with a newer server version gives `pair` |
| Double rotation after a concurrent owed rotation | P2 | Stops when another device already rotated and `rotation_due` is clear |
| Open tabs pick up rotations only on load; old-key uploads | P2 | Key check on visibility and on the sync tick. History entries must use the current version (`409 key_version_conflict`, then key check and retry). ADR wording corrected |
| Dishonest-server consequences of `rotation_due` undocumented | P2 | Documented. Revoked device IDs are persisted and excluded until an excluding rotation succeeds |
| `not_ready` rotation shows a misleading Retry | P2 | Runs a key check instead |
| `importChain` stores older versions unchecked | P2 | Checks the verify key and the signed chain link |
| Unregistered departing device does not set `rotation_due` | P2 | Documented |
| Report §9 hash, CI for HEAD | P2 | Report and CI history updated |

## Round 4 — commit 79f6446 — FAIL

0 P0, 2 P1, 5 P2 findings.

Every Web, root and lint command passed. The account e2e suite passed 19 tests in each of the five projects. The round-3 P0 is verified fixed (live and in unit tests). The round-3 P2s are verified fixed client-side, and earlier rounds did not regress.

**What held up under review:**

- every key input is authenticated by something the device already holds: the recovery key signature, device proofs, rotation signatures, chain imports, pending pickup, and pairing and recovery;
- automatic actions are bounded;
- the current-version history rule holds under concurrency (`FOR SHARE`);
- state handling for left-behind, refused, `not_ready` and remembered exclusions;
- guest-first, flags, i18n, tokens and the bundle budget.

**Why it failed:**

- **P1-1:** a revoke racing another device's owed rotation (with `rotation_due` already true) could leave the revoked device a deliverable blob for the new version while `rotation_due` was cleared. `detach`'s conditional update skipped the locked row instead of waiting for it. This was reproduced live, 4 of 12 tries.
- **P1-2:** the required `TestHistorySeqParallel` was flaky (about 10 %). The reader checked "writers finished" after reading a page, so it could stop one entry early. The flakiness was in the test, not the product.

### Resolution of round 4 findings

| Finding | Severity | Resolution |
|---|---|---|
| Revoke racing an owed rotation | P1 | `detach` locks the affected `account_keys` rows `FOR UPDATE` (the rotation's lock) before deleting anything, and sets `rotation_due` unconditionally. Pending blobs are delivered only to a device that still has a registered key. `TestRevokeRacingOwedRotation` (40 concurrent iterations) and `TestPendingOnlyForRegisteredDevice` both fail on the old code and pass now |
| Flaky `TestHistorySeqParallel` | P1 | The reader notes "writers finished" before each query and stops only on an empty page read after that. 80 of 80 runs pass |
| Remembered exclusion can block every rotation | P2 | On `devices_changed` listing a remembered device as missing, the client checks `GET /v1/devices` and forgets it if it is still in the account. IDs revoked in the current call are never dropped |
| `rotateNow` silently skips when `recovery` is null | P2 | Gives `rejected` |
| Chain-import authenticity scope | P2 | Documented as holding against parties without a newer ADK |
| Report legacy wording; CI entry | P2 | Report §6 covers migrations 0007 and 0009; CI history updated |
| History 409 path bypasses the throttle | P2 | Documented as bounded (at most two rotations per tick, denial of service only) |

## Round 5 — commit 7fa9f27 — FAIL

0 P0, 1 P1, 3 P2 findings.

All commands passed, and the account e2e suite passed 19 tests in each of the five projects. Both round-4 P1s are verified fixed:

- the race tests fail on the pre-fix code and pass 10 of 10 now;
- the lock fix holds even without the pending filter;
- the live race script finds 0 of 12;
- a lock-stress probe across rotate, revokes, sign-out, registration, pairing wrap, history writes and the sweep found no deadlocks;
- `TestHistorySeqParallel` passes 60 of 60, against 2 of 60 failing before the fix.

**Why it failed:**

- **P1-1:** the round-4 client rule for remembered exclusions forgot a remembered device when the server answered `devices_changed` listing it as `missing` and `GET /v1/devices` still listed it. A dishonest server colluding with that device, or a revoked device that signed in again, could get the new ADK wrapped to it. The owner documents still described the stricter rule.

### Resolution of round 5 findings

| Finding | Severity | Resolution |
|---|---|---|
| Remembered exclusion dropped on the server's word | P1 | Replaced: a remembered device still listed is revoked again and stays excluded, and it is never re-included. A server that ignores the revoke can only block the rotation. CLIPBOARD_PROTOCOL §1.8 and §1.11 and SECURITY_MODEL §7 describe the rule and its real strength: by device ID, so it does not stop a colluding holder of the current ADK that proves a fresh ID. Vitest covers the repeated revoke, a server that ignores it, and IDs revoked in the same call |
| Registration racing the device's own revoke left an orphan key row | P2 | `RegisterDeviceKey` locks the caller's live session row `FOR SHARE` inside its transaction, in `detach`'s lock order. `TestRegisterRacingOwnRevoke` fails on the old code and passes now |
| `rejected` copy reused for a missing recovery key | P2 | Documented in CLIPBOARD_PROTOCOL §1.8 (an honest server always returns the signed recovery key) |
| CI entry for HEAD | P2 | Added to the CI history |

## Round 6 — commit dd0df12 — FAIL

0 P0, 1 P1, 4 P2 findings.

All commands passed. The account e2e suite passed 19 tests in each of the five projects. Every round-5 resolution was verified:

- `completeRevokes` acts only on IDs this browser remembered revoking, with no loop.
- The registration race test passes 30 of 30 now and fails on the pre-fix code.
- No regressions in the round 1–4 protections, live or in probes.

**Why it failed:**

- **P1-1:** `Rotate` checked the caller's account session before its transaction. A device being evicted, by a password change, a reset or a revoke, had rotation requests queued behind the key-row lock. One landed after the eviction committed, created the next ADK version and cleared `rotation_due`, so the evicted device knew the current key. This reproduced 8 of 8 times live and 30 of 30 in Go probes.

### Resolution of round 6 findings

**P1 — Evicted device's rotation lands after the eviction.**

Departures and key writes now serialize on the account's `account_keys` row:

- `detach` locks the row `FOR UPDATE` for every affected account, not only those whose leaving device had a key.
- Rotation, key registration and pairing wrap hold the row `FOR UPDATE`; history writes hold it `FOR SHARE`. Each re-checks the caller's session after taking the lock.
- Only a device with its own key proven at the current version may rotate (`403 device_key_unproven`).
- No session row is locked. A first attempt with `FOR SHARE` session locks let a hammering device delay its own eviction by minutes; that showed up in the test's run time and was replaced.
- `TestEvictedDeviceRotationRace` and `TestRotateNeedsOwnCurrentProof` fail on the old code and pass 5 of 5 now. The earlier race tests still pass.

**P2 findings:**

| Finding | Resolution |
|---|---|
| Remembered exclusion could later revoke a device the user added back | Each exclusion stores the key version at revoke time. It is dropped once the account rotated past it and the device has no key, or once the device holds a key proven at a newer version (checked with this browser's own ADK). Vitest covers both drop rules and two keep cases (forged newer proof, proof from the revoke version) |
| Wrong code comment in `completeRevokes` | Fixed |
| Registration lock not in an owner doc | SECURITY_MODEL §4 describes the serialization for all key writes |
| ios-safari CI flake in `signin-during-transfer` | Not reproduced locally (8 of 8 repeated runs passed). Both peers were connected, but no block arrived within 30 s. The likely cause is a data channel that failed to open, which the receiver recovers from by design: it redials after its 20 s open timeout. The diagnostics now record data-channel open, close, error and open timeout on both sides. The test waits 60 s for the second transfer's first block, like the multi-receiver specs; the wait is not what the test checks |

## Round 7 — commit e41e6d3 — FAIL

0 P0, 1 P1, 6 P2 findings. All commands passed, and the account e2e suite passed 19 tests in each of the five projects. CI 42997152648 was green with no retries.

The round-6 server fix holds:

- the live hammer script found 0 of 8;
- the Go eviction probes found 0 of 30 each over 8 runs;
- the new tests pass 15 of 15 with flat run times and fail on dd0df12;
- no deadlocks under extended lock stress;
- no regressions in rounds 1–5.

**Why it failed:**

- **P1-1:** a remembered exclusion recorded this browser's own key version. When the browser lagged the account at revoke time, its first key check picked up the newer key and pruned the entry, because the account had moved past the recorded version and the device had no key. If the rotation then failed and the revoked device signed in again and proved a key at the current version, the next rotation wrapped to it. QA reproduced this with an honest server.

### Resolution of round 7 findings

| Finding | Severity | Resolution |
|---|---|---|
| Exclusion dropped when the browser lagged at revoke time | P1 | The recorded version is the larger of the browser's and the server's `key_version`, read before `DELETE /v1/devices/{id}`. A rotation that excludes IDs raises them to the current version before pruning. Vitest covers both, including the QA lag scenario with a failed rotation |
| History writes (`FOR SHARE`) can delay departures | P2 | Documented in SECURITY_MODEL §4, with the measured bound and the rate limit that ends it; a fair per-account lock queue is in the backlog |
| Stale test comment | P2 | Fixed |
| Docs said pruning runs on every key check | P2 | CLIPBOARD_PROTOCOL §1.8 says it runs at the start of each rotation |
| 60 s wait hides the event the diagnostics capture | P2 | Diagnostics are attached to a passing test too when they contain a data-channel open timeout, with a warning annotation; CI uploads artifacts always |
| Pairing created during its device's departure | P2 | CreatePairing serializes on the account key row and re-checks the session. Lookup and wrap require the new device to have a live, added session. `TestPairingNotOfferedForDepartedDevice` covers it |
| CI history and report hash | P2 | Added |

## Round 8 — commit 9b76992 — PASS

0 P0, 0 P1, 4 P2 findings. Every command passed, and the account e2e suite passed 19 tests in each of the five projects locally. CI 43003792138 was green on the first attempt in every job, and nightly 43003792203 was green.

The round-7 P1 is verified fixed. The lag proof wraps the new key to the revoked device on e41e6d3 and does not on 9b76992. The pairing liveness fix is verified against the old code, which leaves rows behind and still allows lookup and wrap after the device leaves; the new code does neither. Every round 1–6 protection still holds in the live scripts and Go probes, and the extended lock stress found no deadlocks.

### Resolution of round 8 findings (after the PASS)

| Finding | Severity | Resolution |
|---|---|---|
| Two network failures in a row could still record a lagging version | P2 | Revoke fails closed. `rememberRevoked` throws when the server's `key_version` cannot be read, and the Devices screen then sends no `DELETE` and shows the error. Vitest covers both layers |
| The raise could record a post-revoke version and revoke a re-added device again | P2 | The raise is removed; the version read before `DELETE` is the only one recorded |
| Docs and comments out of step with the code | P2 | CLIPBOARD_PROTOCOL §1.8, SECURITY_MODEL §4 (pairing creation holds the key row `FOR SHARE`), and the `keyFlow.ts` comments corrected |
| Report, test and log bookkeeping | P2 | Report test count and backlog (fair lock queue, ios-safari stall root cause) updated. `TestPairingNotOfferedForDepartedDevice` also asserts that wrap is refused. CI entry added |
