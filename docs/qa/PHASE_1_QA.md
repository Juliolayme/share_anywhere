# QA — Phase 1

Independent review by the `qa-reviewer` agent (`.claude/agents/qa-reviewer.md`). The agent is read-only; the engineer applies fixes and the agent re-runs.

## Round 1 — commit ff48c53 — FAIL

No P0. Four P1 and seven P2 findings. Every check passed (backend vet, lint, race tests with PostgreSQL, coverage 86–100 % per gated package, govulncheck; web format, lint, typecheck, 42 unit tests, build at 90.5 kB gzip; protocol, tokens, i18n, brand, script tests, markdown lint, audit; local Playwright 18 passed). CI run 42787622458 on f6f559c was green in every job, including `e2e-web` on all five projects.

### Resolution of round 1 findings

| Finding | Severity | Resolution |
|---|---|---|
| P1-1 A cookie refresh could ask for `transport: "body"` and read the refresh secret from the response | P1 | The transport is fixed per device at creation (`devices.refresh_transport`, migration 0002). Refresh and reset answer only in that transport and accept no transport field (`400` otherwise). Tests: `TestCookieDeviceSecretNeverInBody`, `TestBodyDeviceKeepsBodyTransportOnReset`, PostgreSQL lifecycle asserts the transport survives reset. ADR 0008, SECURITY_MODEL §4, ARCHITECTURE §8, OpenAPI updated |
| P1-2 `ip_hash` was always redacted | P1 | `ip_hash` is a safe key in the redactor; the test asserts a 16-hex value. Verified in the local stack's backend logs |
| P1-3 Receive showed Continue and Open link that led nowhere; "coming soon" banners; QR hint pointing to a missing route | P1 | Both actions and the QR hint render only with the `sharing` flag. The code is validated when focus leaves an incomplete code, the link on blur. The `sharing_soon` / `joining_soon` banners and keys are removed. Deviation F5 and test names match the code |
| P1-4 Hard-coded labels and an English "min" in a Vietnamese message; screen IDs absent | P1 | `product.nav_main` and `product.steps`; the reset rate-limit toast uses `m:ss`. Every page root carries `data-screen="<design id>"`, and unit and e2e test titles start with the screen ID |
| P2-1 Cross-site form POST could replace the identity cookie | P2 | `httpx.Decode` requires `Content-Type: application/json` on any non-empty body; test with `text/plain` |
| P2-2 Header theme toggle out of sync with Settings | P2 | One theme store (`useTheme`) for both controls; unit and e2e checks |
| P2-3 `.env.example` lacked the Vite variables; limits described as configuration; TR-3 route; missing error codes | P2 | All four fixed |
| P2-4 Report pointed to a missing QA file; stale local images | P2 | This file; the local stack was rebuilt from the fixed code before the e2e rerun |
| P2-5 Access matrix narrower than documented; integration tests skip instead of a build tag | P2 | Backlog for Phase 2, when the participant level adds rows; expired and revoked cases stay covered per endpoint |
| P2-6 Privacy text key, Send offline state, History tabs keyboard, new product keys not listed, Clear history errors | P2 | `web_vv.k74`; Send offline banner; roving tabindex and tabpanel; deviation E13; Clear history shows `product.history_unavailable` on failure |
| P2-7 Open WebSockets survive revocation | P2 | Phase 2 backlog (before signaling uses the socket) |

User decisions recorded on 2026-11-10: the `CLAUDE.md` wording ("security words", keep-open banner with the screen-on pill), deviation C5 (44 px header controls) and deviation section F are approved.

## Round 2 — commit ce7933f — PASS

No P0 or P1. All four round-1 P1s verified fixed, including live attempts to break them (cookie refresh with body fields, cookie secret presented in the body, reset with a body, `text/plain`, empty and chunked content types, oversized and trailing bodies, native-device reset). Every check passed; coverage devices 89.2 %, access 97.8 %, ratelimit 100 %, clientip 91.4 %, httpserver 96.4 %, ws 85.4 %. CI run 42790219354 on ce7933f was green in every job, including `e2e-web` on all five projects. Deferring round-1 P2-5 and P2-7 to Phase 2 was judged acceptable (no client socket or rooms yet); P2-7 must close before Phase 2 signaling uses the socket.

### Resolution of round 2 P2 findings (follow-up commit)

| Finding | Resolution |
|---|---|
| CSP blocked fonts Vite inlined as `data:` URIs (Vietnamese and Cyrillic-ext subsets) | `build.assetsInlineLimit` never inlines `.woff`/`.woff2`; the CSP stays `font-src 'self'`. New e2e check: zero CSP console violations across all screens, including Vietnamese |
| Send review kept the `send` screen ID | `send-review` once files are picked; e2e check |
| History filter dropdowns named by an option's text | `product.filter_status`, `filter_date`, `filter_device` |
| History tabs lacked Home and End | Added to the roving tabindex handler |
| Clear history always blamed blocked storage; Settings dialog could be submitted twice | `product.clear_failed` unless storage is unavailable; busy state in Settings |
| Report CI evidence and coverage figure | Run 42790219354 added; httpserver 96.4 % |
| API error table order and `500 internal` | Sorted by status; `500 internal` added |

**Phase 1 QA verdict: PASS.**
