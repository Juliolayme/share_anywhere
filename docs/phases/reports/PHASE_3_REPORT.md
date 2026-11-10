# Phase 3 report: Web ↔ Web peer-to-peer file transfer

Status: **implemented**, with one open gate item (Firefox, §6). All transfers here run between guest devices.

- **Chromium and WebKit:** Web-to-Web transfers work end to end, including the iPhone 14 and Pixel 7 profiles. Verified locally and in the CI `e2e-web` matrix.
- **Firefox:** the receiver does not connect in Playwright's Firefox build, locally or in CI.

Date: 2026-11-10. Branch: `claude/practical-lovelace-avlb5g`.

## 1. What was implemented

### Implemented and tested

**Backend**

- **`internal/transfers`** (sixth backend package): per-receiver, per-file transfer records.
  - `GET /v1/sessions/{id}/transfers`:
    - the sender sees every transfer plus each receiver's status and transfer-capability hash;
    - a `JOINED` receiver sees its own transfers and its capability.
  - `GET /v1/transfers/{id}`.
  - `POST …/report`. The server validates every transition (`docs/ARCHITECTURE.md` §4.5):
    - verified bytes are monotonic and never exceed the file size;
    - only the receiver may complete, and only once every byte is verified;
    - terminal states are idempotent;
    - an ended session refuses changes.
  - `pause`, `resume` (a receiver must present its capability) and `cancel`.
  - `TRANSFER_UPDATED` events go to the sender and that receiver; session events and last-activity are updated.
  - Metrics: completed, failed, cancelled, resumes, route counts, verified bytes.
  - Reports are limited to 300 per minute per device.
- **`GET /v1/sessions/{id}/files`.**
- **Transfer capability:**
  - 256-bit HMAC of participant, device and join time.
  - Revoked with the participant's status; a rejoin issues a new one.
  - A rejoin after Remove resets the receiver's cancelled transfers to `PENDING`.
- **Contract:**
  - `openapi.yaml` covers §2.3 (31 operations).
  - `websocket-events.json` has `TRANSFER_UPDATED`.
  - `docs/API.md` §2.3, §3, §4 updated.
  - The never-scheduled "add files after creation" rows moved to §2.7 (backlog).

**Transfer engine** (`web/src/features/transfer/engine/`, protocol in `docs/TRANSFER_PROTOCOL.md`)

- **Framing:** a 20-byte header on every message. Types: `HELLO`, `FILE_META`, `BITMAP`, `BLOCK`, `ACK`, `NACK`, `PAUSE`, `RESUME`, `DONE`, `ERROR`.
- **Sizes:** 4 MiB blocks; frames of at most 64 KiB, and never more than the peer's `maxMessageSize`.
- **Hashing:** SHA-256 per block (WebCrypto), and a streamed whole-file SHA-256 (`@noble/hashes` 2.4.0, fed in order while the file is read).
- **Flow control:** 4-block window and `bufferedAmount` backpressure.
- **Receiver:** checks length and digest, writes, flushes, persists the bitmap, then `ACK`s; `NACK` triggers up to 3 re-sends. After the last block it re-reads the file and verifies the whole-file hash.
- **Resume:** exchanges the bitmap (holes and out-of-order blocks included).
- **Reads:** the sender reads with `File.slice()` only, never the whole file.
- **Test vectors:** `shared/protocol/schemas/transfer-vectors.json` holds frames of every type, bitmap encodings, block and file hashes, and frame counts. `vectors.test.ts` reproduces them exactly.

**Web**

- **Storage:**
  - OPFS through synchronous access handles in a worker (all engines), with the file size reserved up front.
  - **Save to a folder** (File System Access, Chromium): blocks are staged in OPFS and each file is copied into the chosen folder after the whole-file check (DESIGN_DEVIATIONS G1).
  - In-memory fallback only where OPFS is missing, capped at 256 MB.
  - Progress is kept in IndexedDB, keyed by the capability hash and the transfer.
- **Capability check before receiving** (PRD §6.8): the detected browser row (folder, browser storage with free space, background behavior) and warnings (iOS keep open, mobile background tabs, large files on iOS, low or no storage).
- **Controllers:**
  - The receiver offers the RTCPeerConnection over WebSocket signaling, with ICE servers from the TURN credentials plus a derived STUN URI.
  - Reconnect with backoff (1 s doubling to 15 s), also when the connection stays "disconnected" for 4 s.
  - Route detection (direct or relay) from the selected candidate pair.
  - Throttled reports that walk the server's state machine.
  - Pause, resume and cancel from either side, also over the server when the channel is down.
  - The sender can serve every receiver from one tab.
- **Screens:**
  - RX-5b `receive-save`, RX-6 `receive-progress`, RX-7 `receive-done` (completed, partial, failed, cancelled; Download per file or "Saved in folder").
  - TR-6 `dashboard`: overall progress, per-receiver cards with route, speed, ETA (provisional until 3 %), Pause, Resume, Details (connection log), Remove; files × receivers matrix; Stop all; Close session.
  - TR-7 `dashboard-done` / `dashboard-partial`.
  - The session screen shows each joined receiver's transfer and opens the dashboard.
- **History:** an entry on both sides when a transfer completes, fails or is cancelled; partial entries show transferred vs. size.
- **Keep screen on:** held while connecting, transferring, reconnecting or verifying, plus the sender's open join window. Released on completion, failure, pause, cancel, removal and session end. The keep-open banner and screen-on pill are on TR-6 and RX-6.
- **Bundle:** the session screens and the engine load lazily; the main bundle is 100.2 kB gzip (was 104.6).

### Implemented but untested

- **Real devices:** iOS Safari background suspension, and Android Chrome with the screen off, have not been tried on hardware.
- **Folder permission prompt after a reload** (Chromium): the native permission prompt cannot be driven in Playwright.
- **TURN relay:** Playwright transfers here connect directly. Forced relay is Phase 8.
- **Files over 2 GB:** see the 20 GB runbook (`docs/runbooks/large-file-manual-test.md`).

### Partially implemented

- **Firefox receiver** (§6).
- **Mobile visual baselines** (carried from Phase 2): the spec (`e2e/mobile/snapshots.spec.ts`) and the generating job (`nightly.yml` `mobile-snapshots`) exist. The baselines still have to be generated on the runner and committed before the PR suite compares them.

### Planned (later phases)

- Five receivers with a shared block cache and a throttled-receiver test: Phase 4.
- Retrying a failed receiver: Phase 4 backlog (DESIGN_DEVIATIONS G4).
- Forced TURN relay and route migration: Phase 8.

## 2. Usable screens and routes

| Platform | Screens / routes |
|---|---|
| Web | `/send/session/:id` (now with receivers' transfers), `/send/session/:id/transfers` (TR-6), `/send/session/:id/result` (TR-7), `/receive/:sessionId/save` (RX-5b), `/receive/:sessionId` (RX-6, RX-7), History entries |
| Backend | §2.3: `GET /v1/sessions/{id}/files`, `GET /v1/sessions/{id}/transfers`, `GET /v1/transfers/{id}`, `POST /v1/transfers/{id}/report`, `/pause`, `/resume`, `/cancel`; WebSocket `TRANSFER_UPDATED` |
| Android, iOS | None in this phase |

## 3. End-to-end workflows executed (all guests)

Local runs used the CI Compose stack, with the backend built with `-tags testhooks` and the Web built with `VITE_TEST_HOOKS=true`. The sender is always a Chromium browser launched in the test; the receiver is the project's browser. Firefox and WebKit were installed locally for this phase.

| Workflow (`web/e2e/transfer/`, `mobile/transfer.spec.ts`) | chromium-desktop | webkit-desktop | android-chrome | ios-safari | firefox-desktop |
|---|---|---|---|---|---|
| 64 MB file, SHA-256 of the download matches, History on both sides survives a reload | Passed locally and in CI | Passed locally and in CI | — (mobile spec) | — | Fails (§6) |
| Pause and resume; wake lock held on both sides, released on pause and completion, re-requested after resume and after hidden → visible | Passed | Passed | — | — | Fails |
| Cancel releases the lock; the sender sees the receiver cancelled | Passed | Passed | — | — | Fails |
| Receiver reload mid-transfer resumes from the bitmap: zero duplicate blocks, blocks received = total − resumed | Passed | Passed | — | — | Fails |
| Corrupted block (test hook) → one `NACK`, re-sent, file matches | Passed | Passed | — | — | Fails |
| Sender drops off → receiver shows Reconnecting and the banner, then completes | Passed | Passed | — | — | Fails |
| Save to a folder (File System Access, picker returns an OPFS folder) | Passed | skipped | skipped | skipped | skipped |
| Private window (ephemeral WebKit, no OPFS) → memory path, 8 MB | skipped | Passed | skipped | — | skipped |
| Mobile: capability row (family, OPFS, folder), warning, 8 MB via browser storage, no horizontal scroll | — | — | Passed locally and in CI | Passed locally and in CI | — |
| Nightly 2 GB with a receiver reload, zero duplicates, SHA-256, JS heap < 512 MiB | Passed locally (1.9 min); CI run in §4 | — | — | — | — |

The Phase 1 and Phase 2 suites still pass on all four working projects (one Phase 2 spec now expects `receive-save` after joining, because RX-4b `receive-joined` was retired).

## 4. Commands and results

| Command | Result |
|---|---|
| `go vet`, `golangci-lint run ./...` | Clean |
| `TEST_DATABASE_URL=… go test -race -count=1 -cover ./...` | All pass. Coverage: `transfers` 89.5 %, `sharing` 77.1 %, `signaling` 83.3 %, `turncreds` 75.0 %, `ws` 89.0 %, `devices` 88.9 %, `access` 98.1 % |
| `pnpm protocol:check` | 31 operations agree with `docs/API.md`; WebSocket schema valid; TS client current |
| `pnpm i18n:check` | EN/VI current, 1,760 keys each |
| `pnpm --filter web format:check`, `lint`, `typecheck`, `test` | Pass; 105 unit tests, including the engine (codec fuzzing, bitmap, hashing against Node `crypto`, resume with zero duplicates, NACK, pause, cancel, unauthorized, 16 KiB message limit), shared vectors, save planning, the transitions mirror, the reporter, the progress store, History rows, and every catalog key used in code |
| `pnpm --filter web build` | Main JS 100.2 kB gzip (budget 120 kB) |
| Playwright, all five projects locally (chromium, android-chrome, webkit, ios-safari; Firefox installed but see §6) | All non-Firefox specs pass |
| CI | Run 42819723606 (58fa83b): 11 of 12 jobs green; `e2e-web (firefox-desktop)` red on the six transfer specs. Later runs are listed in `docs/qa/PHASE_3_QA.md` |

## 5. Environment variables and external services

- **New:** `VITE_TEST_HOOKS` (Web build argument, `true` only on the CI stack; `docker-compose.ci.yml`).
- **TURN:** as in Phase 2 (`SA_TURN_SECRET`, `SA_TURN_URIS`); clients derive a `stun:` URI from the TURN URIs.
- **Nightly:** `E2E_LARGE=1` and `E2E_FIXTURE_DIR`.

## 6. Known limitations and untested behavior

- **Firefox receiver.** In Playwright's Firefox build the RTCPeerConnection never gathers a candidate: `iceGatheringState` stays `new` and ICE fails at once, even with no ICE servers. I reproduced this locally, and in CI the receiver stays at 0 bytes. Chromium and WebKit connect in the same environment. This is being diagnosed with the ICE diagnostics the transfer specs now attach on failure. Until it is resolved, the exit gate's "three desktop engines" is met for two of them.
- **Off-the-record contexts keep OPFS in memory.** Chromium incognito-like contexts (Playwright's default) are affected, so the nightly run uses a persistent profile. Real incognito windows could hit a storage error on large files. The capability check cannot see this, and the receiver shows "This device ran out of storage space".
- **Picked files live only in the sender's tab.** A sender reload loses them (the browser gives no persistent access). Both screens explain it and receivers end with "The sender's tab no longer has the files".
- **Web limits:** no "Open" or "Show in folder" on the Web (G3); Retry for a failed receiver is not built (G4).

## 7. Backlog

| Priority | Item |
|---|---|
| P0 | Firefox receiver connectivity in CI (exit gate) |
| P1 | Commit the runner-generated mobile baselines and turn on comparison in the PR suite; retry for failed receivers (Phase 4); Firefox `navigation-retry` root cause (from Phase 2) |
| P2 | Move whole-file hashing into a worker on the sender (it shares the main thread with the block reader); unit tests for the controllers with a fake RTCPeerConnection; sender notice for auto-declined receivers (F13) |

## 8. Local run

Same as Phase 2: `docker compose up --build`, then open `https://localhost:8443` in two browser profiles. One sends a file. The other enters the code, picks where to save, and receives.

## 9. Commits

| Commit | Summary |
|---|---|
| 4929481 | Phase 2 closed (QA PASS) |
| 1a0e0cb | Backend: transfer records, state machine, transfer capability |
| 47edd22 | Engine core, protocol v1 document, shared vectors |
| 58fa83b | Storage, controllers, transfer screens, Playwright transfer specs |
| 420ca24 | Nightly 2 GB job, diagnostics, docs |
| 6c72d11 | Nightly jobs run when they change on a branch |
| c00837a | Mobile baselines job; History transferred vs. size |
