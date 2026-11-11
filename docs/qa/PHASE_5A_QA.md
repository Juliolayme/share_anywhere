# QA — Phase 5A (accounts, device linking, Devices list, cloud history)

Independent review by the `qa-reviewer` agent (`.claude/agents/qa-reviewer.md`). The agent is read-only; the engineer applies fixes and the agent re-runs.

## CI history of the phase

- [42947804008](https://github.com/Juliolayme/share_anywhere/actions/runs/42947804008) on 734d716: every job green, e2e first attempt in all five projects (guest flows on the new backend).
- The `security` job (gitleaks) failed on a598989 and 96575ba: published protocol test vectors and a type field were flagged. Fixed in 734d716 (fingerprints plus a path allowlist).
- [42961740565](https://github.com/Juliolayme/share_anywhere/actions/runs/42961740565) on e3289ba: backend, web, protocol, docs, compose and e2e-web in all five projects passed with no retries (account suite included); `security` failed on a new Go advisory, GO-2026-6859 (net/http, fixed in go1.27.4). Fixed in 5fdffe0 (toolchain go1.27.4).
- [42962832188](https://github.com/Juliolayme/share_anywhere/actions/runs/42962832188) on 5fdffe0: every job green, `security` included. One WebKit test (`p2p.spec.ts` reconnect) passed on retry: it waited only the default 5 s for the first verified block. 3987ac8 gives it 30 s like the other specs in the file.
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
