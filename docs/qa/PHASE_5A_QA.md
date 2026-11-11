# QA — Phase 5A (accounts, device linking, Devices list, cloud history)

Independent review by the `qa-reviewer` agent (`.claude/agents/qa-reviewer.md`). The agent is read-only; the engineer applies fixes and the agent re-runs.

## CI history of the phase

- [42947804008](https://github.com/Juliolayme/share_anywhere/actions/runs/42947804008) on 734d716: every job green, e2e first attempt in all five projects (guest flows on the new backend).
- The `security` job (gitleaks) failed on a598989 and 96575ba: published protocol test vectors and a type field were flagged. Fixed in 734d716 (fingerprints plus a path allowlist).
- [42961740565](https://github.com/Juliolayme/share_anywhere/actions/runs/42961740565) on e3289ba: backend, web, protocol, docs, compose and e2e-web in all five projects passed with no retries (account suite included); `security` failed on a new Go advisory, GO-2026-6859 (net/http, fixed in go1.27.4). Fixed in 5fdffe0 (toolchain go1.27.4).
- [42962832188](https://github.com/Juliolayme/share_anywhere/actions/runs/42962832188) on 5fdffe0: every job green, `security` included. One WebKit test (`p2p.spec.ts` reconnect) passed on retry: it waited only the default 5 s for the first verified block. 3987ac8 gives it 30 s like the other specs in the file.
- [42967732687](https://github.com/Juliolayme/share_anywhere/actions/runs/42967732687) on 4446bee (QA round 1 fixes): every job green, e2e first attempt in all five projects (chromium 63, firefox 62, webkit 63, android-chrome 56, ios-safari 56).
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
