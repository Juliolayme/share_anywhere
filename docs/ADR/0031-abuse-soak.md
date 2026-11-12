# ADR 0031: Abuse soak, and the code-guessing alarm

Status: Accepted (Phase 9, 2026-11-12)

## Context

Open join (PRD §2, docs/SECURITY_MODEL.md §3) admits whoever presents a live six-digit code. The defences are
the 10-minute join window, per-address and per-device failed-lookup lockouts, the per-address device-creation
limits with proof of work, and the global protected mode that forces approval for code joins once failed lookups
across the service exceed `CODE_GUESS_ALARM_PER_MIN` (default 300). Phase 9 asks for a soak with a Go load
generator to check that these hold, to measure how many guesses get through before protected mode trips, and to
tune the alarm.

## Decision

- **An in-process load generator** (`backend/cmd/server/soak_test.go`, `TestAbuseSoak`) drives the whole server
  (every module, production limits, real PostgreSQL) through its HTTP handler with a distinct client address per
  simulated client and a fake clock, so a simulated hour runs in seconds and the results are deterministic. It is
  not a network benchmark: it measures the limits, not throughput. It runs in CI with the backend tests, and
  nightly (`abuse-soak`) with five times as many open sessions, writing its measurements as a JSON artifact.
- **Scenarios and asserted outcomes:**
  - One address creating identities: 3 free, 7 more with proof of work, then refused for the hour.
  - 200 people behind one IPv4 address (CGNAT): 3 free new identities (10 with proof of work) and 30 new sessions
    per hour for the whole address. Measured and documented as a limitation; not changed (below).
  - A distributed burst, every guess from a fresh address and device so per-address and per-device lockouts
    never apply: protected mode trips at exactly 300 failed lookups; afterwards a correct code yields `REQUESTED`
    (sender approval) and link joins on other addresses still succeed (20 of 20).
  - A slow attack at 290 guesses per minute for a whole join window: 2,900 guesses without tripping protected
    mode, a 0.29 % chance per session per window, matching the model's bound of `alarm × 10`.
  - One address guessing alone: at most 10 failed lookups, then locked out.
- **Lockout off-by-one fixed.** The soak found that the failure which exhausted the allowance did not lock the
  address or device until one more failure: 11 failed lookups per address (and 6 per device) got through instead
  of 10 (and 5). The failure that uses up the allowance now starts the lockout (`sharing.failedLookup`), and the
  sharing test asserts the exact counts.
- **`CODE_GUESS_ALARM_PER_MIN` stays at 300.** The soak confirms the model in docs/SECURITY_MODEL.md §3.2: with
  `N` open windows an attacker below the alarm gets `300 × N / 10^6` expected hits per minute, and the alarm, not
  the per-address limits, is what bounds a distributed attacker. Lowering it shrinks that bound linearly but also
  trips protected mode on honest typos sooner: there is no production traffic yet to measure the typo rate
  against, so the default stays and remains configurable; revisit with real failed-lookup metrics
  (`sa_code_lookups_failed_total`, `sa_protected_mode_activations_total`, `sa_protected_mode_active`). Senders of sensitive files keep Require approval
  and link or QR sharing.
- **CGNAT stays a documented limitation.** Per-address keys are what make the device-creation and guessing
  limits meaningful; relaxing them for shared IPv4 addresses would equally relax them for attackers. IPv6 clients
  are keyed per /64. The limitation is listed in `KNOWN_LIMITATIONS.md`.

## Consequences

- The guessing defences are regression-tested at production values on every backend change.
- The soak cannot reproduce a botnet's network behaviour or the service's real typo rate; both need production
  metrics. The model and measurements are documented in docs/SECURITY_MODEL.md §3.2.
