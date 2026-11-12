# Security review — Phase 9

Review of the built system against `docs/SECURITY_MODEL.md` (every abuse case in §7, the controls checklist in §9, and the open-join residual risk in §3.2). Each row names the automated evidence; "manual" marks what no test can show. Reviewed on 2026-11-12 at the Phase 9 head.

## Findings

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Failed code lookups: the failure that used up the allowance did not start the lockout, so 11 failures per address (6 per device) got through instead of 10 (5) | Low (one extra guess per address per hour) | Fixed in Phase 9 (`sharing.failedLookup`); `TestLookupLimitsAndLockouts` asserts the exact counts; found by the abuse soak |
| 2 | Shared IPv4 addresses (CGNAT) share every per-address budget: 3 free new identities (10 with proof of work) and 30 new sessions per hour for everyone behind the address | Product limitation | Accepted (ADR 0031); listed in `KNOWN_LIMITATIONS.md` |
| 3 | govulncheck reports GO-2026-5932 (`golang.org/x/crypto/openpgp`, unmaintained) in a required module | Informational | Not reachable: no package imports `openpgp`; govulncheck reports 0 vulnerabilities in called code. No released fix yet; take the next `x/crypto` release |
| 4 | `TestPresenceOrderAcrossSockets` failed once in about 30 runs | Test defect | Fixed: the test waited for one device's final presence event only |
| 5 | Concurrent code lookups from one address all passed the lockout check while one failure was left (about 19 failures instead of 10 across a burst; QA round 1) | Low | Fixed: lookups are serialized per address and per device (`sharing.lookupGate`); `TestConcurrentLookupsStopAtTheAllowance` fails without it. The documented ceiling is now 10 in a row and at most 15 in the first hour (bucket refill during the lockout) |

No finding needed a change to an access level, a limit value or a token lifetime.

## Abuse cases (`docs/SECURITY_MODEL.md` §7)

| Abuse case | Evidence |
|---|---|
| Guessing a code to receive files (open join) | `TestAbuseSoak` (protected mode trips at exactly 300 failed lookups; code joins then `REQUESTED`; slow attack under the alarm: 2,900 guesses per window, 0.29 % per session; one address: 10 failures in a row, then locked out); `TestConcurrentLookupsStopAtTheAllowance` (concurrent bursts); `TestLookupLimitsAndLockouts`; e2e `pairing/window.spec.ts` (protected mode makes a code join wait, with the explanation) and `pairing/join.spec.ts` (lockout message) |
| Guessing a code to read the preview | Same limits; the preview carries only the documented fields (OpenAPI `JoinPreview`; e2e `pairing/join.spec.ts`) |
| Shoulder-surfing, leaked link or QR | Join window of at most 10 minutes, Create new code invalidates the old code and token, Stop accepting: `sharing` window tests, e2e `pairing/window.spec.ts`, Android `ReceiverJoinTest`, iOS `TransferUITests.testTheCodeExpiresCreateNewCodeKeepsTheJoinedReceiver` |
| Removed or blocked receiver keeps receiving | `TestRemoveRevokesAndRejoinRestarts`, `TestRemoveFreesSlotAndBlockCoversDeviceAndAddress`, `TestCloudRefusesNotAddedDevicesRemovedReceiversAndEndedSessions`; e2e `pairing/join.spec.ts` (Remove and Block; a blocked receiver cannot rejoin); iOS `testRemoveAndBlockReceivers` |
| Block evasion by resetting identity | Block covers the address /64 (`TestRemoveFreesSlotAndBlockCoversDeviceAndAddress`); device creation limits (`TestAbuseSoak` Sybil scenario) |
| Sybil devices | `TestAbuseSoak` (one address: 3 free, 7 with proof of work, then refused); `devices` limit and proof-of-work tests |
| Join-request flooding | Join limits and pending requests counting toward the five slots: `TestFiveReceiverCapUnderConcurrency`, `sharing` join-limit tests |
| Impersonation through names | Security words on both sides (e2e pairing specs, Android and iOS join tests); manual: user judgement |
| TURN as a free relay | `TestIssueHTTP` (participants of live sessions only), `TestRelayCapStopsRenewal`, `TestCredentialsAgainstCoturn`; `TestIDORSweep` (strangers refused) |
| Hosting abuse via Cloud | `TestCloudPreconditions`, `TestCloudBudgetPausesAndResumes`, `TestCloudSweepKeepsExhaustedObjectsPausedUntilTheMonthTurns`, `TestCloudRefusesNotAddedDevicesRemovedReceiversAndEndedSessions`, `TestIDORSweep` |
| Server or store reading cloud files | Shared vectors `cloud-vectors.json` on Web, Android and iOS; the backend handles ciphertext only (`objectstore`, Cloud tests) |
| Stolen access token | `TestTokenExpiryAndKeyRotation` (15-minute TTL, EdDSA only); account claims checked against the live account session (`TestAccountLevelsFromOpenAPI`, forged `dl` refused) |
| Stolen refresh secret | `TestRefreshRotationAndReuseRevokes`, `TestPGStoreReuseGrace`, `TestPGStoreConcurrentRefresh`; Web cookie flags (`TestRefreshOverHTTP`) |
| Account takeover, reset, enumeration | `TestSignUpSignInSignOut`, `TestPasswordResetSingleUse`, `TestResetMailFailureLogsNoAddress`, sign-in limit tests in `internal/auth` |
| Not-added signed-in device | `TestAccountLevelsFromOpenAPI` (`403 device_not_added` on every `account+device` route), `TestNotAddedWebSessionBoundToBrowser`, `TestSignInKeepsDeviceAndNotAddedExpires` |
| Key substitution, rotation and former devices | `internal/auth` key tests and the shared crypto vectors (Phase 5A QA rounds 1–3) |
| CSRF on the refresh cookie | `SameSite=Strict`, path scope and the custom header (`TestRefreshOverHTTP`) |
| Transfer takeover | Capability checks (`TestActionsAndCapability`, `TestListScopesAndCapability`); `TestIDORSweep` |
| IDOR across modules | `TestIDORSweep`: a stranger and a receiver get a 4xx on every participant route with a resource id, Cloud's object routes and TURN on another's session, and nothing changes; per-package checks for keys, pairing, history and clipboard (`internal/auth/keys_test.go`, `internal/clipboard`) |
| Rate limits and CGNAT | `TestAbuseSoak` CGNAT scenario (finding 2) |
| Signaling denial of service | `TestPerDeviceConnectionCap`, `TestRejectsMissingExpiredTicketAndBadOrigin`, message rate limits in `internal/platform/ws` |
| Script in the Web origin | CSP enforced (`script-src 'self'`, no inline scripts) in `web/Caddyfile` and `infra/caddy/Caddyfile.macos`; e2e `guest/guest-first.spec.ts` asserts no CSP violations on every route |
| Clipboard and history plaintext | `TestNoPlaintextAtRest` (clipboard), nightly `clipboard-cross-client` (database dump has no plaintext), history AAD tests |
| Keep-screen-on draining battery | Held only while waiting or transferring, released on completion, pause, cancel and window end, and never with the setting off: Web `p2p.spec.ts` ("the screen-on lock follows on both sides", released after completion), `pairing/window.spec.ts`, `keep-awake.spec.ts`, `keepAwake/controller.test.ts`; Android `KeepScreenOnTest` (no wake lock held after the transfer, screen off, setting off); iOS `testKeepScreenOnFollowsTheSettingAndTheAppComingBack`, `testCancellingTheReceiveLetsTheScreenSleep`. Manual: battery drain on real devices (real-device checklists) |

## Controls checklist (`docs/SECURITY_MODEL.md` §9)

| Control | Evidence |
|---|---|
| Parameterized SQL only | `pgx` placeholders throughout; `gosec` in golangci-lint (CI `backend`, 0 issues) |
| Input validation on every endpoint | OpenAPI schemas with `additionalProperties: false`; handler validation tests per package |
| Strict CORS allowlist, WebSocket `Origin` | `TestOriginsAreTrimmed`, `TestRejectsMissingExpiredTicketAndBadOrigin`, one-time 30 s tickets (`TestWelcomeAndSingleUseTicket`) |
| CSP and safe headers | Enforced CSP (not report-only) plus `nosniff`, `frame-ancestors 'none'`; e2e CSP-violation check |
| Every route enforces its access level | `TestRouteTableMatchesOpenAPI`, `TestNonPublicRoutesRejectAnonymousCalls`, `TestAccountLevelsFromOpenAPI` |
| IDOR tests for every resource | `TestIDORSweep` plus the per-package cross-account tests listed above |
| Token lifetimes | Access token 15 min (`TestTokenExpiryAndKeyRotation`); TURN 30/60 min (`TestSignMatchesCoturnRESTScheme`); join window ≤ 10 min and link tokens ≥ 128 bits (`sharing` tests); WebSocket ticket 30 s |
| Logs redact secrets and personal data | `TestRedactsSensitiveKeys`, `TestRedactsJWTLikeValues`, `TestRedactsTokensInsideErrors`, `TestRequestLogHasIPHashNotAddress`, `TestRequestLogRedactsPairingCode`, `TestRequestLogOmitsQueryString` |
| Dependency, image and secret scanning | CI `security` on every change: gitleaks over the full history (`fetch-depth: 0`; locally 211 commits, no leaks), govulncheck (0 reachable; finding 3), `pnpm audit --audit-level high` (none), Trivy on the backend image (0 HIGH/CRITICAL) |

## Not covered by automation

Real-device battery drain and TalkBack/VoiceOver use; a volumetric or botnet attack on real networks; the honest code-typo rate (needs production metrics, ADR 0031); TURN over TLS on 443 with a real certificate.
