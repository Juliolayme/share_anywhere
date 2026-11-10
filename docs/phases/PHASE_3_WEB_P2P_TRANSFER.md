# Phase 3 — Web ↔ Web P2P file transfer

Read: PRD §5.10, §6.1–§6.5, §6.8, §11, §13 (Transfer, Keep screen on); `docs/ARCHITECTURE.md` §5, §7; `docs/SECURITY_MODEL.md` §7; `docs/TESTING_AND_CI.md` §3, §6.

Why Web first: two browser contexts on one CI runner give a fully verifiable P2P path. Android (Phase 6) and iOS (Phase 7) reuse this protocol and its test vectors in `shared/protocol/schemas/transfer-vectors.json`, which this phase must publish.

## Scope

All transfers in this phase run between **guest** devices; accounts do not exist yet.

- Transfer engine in `web/src/features/transfer/engine/`: block scheduler (4 MiB blocks, 64 KiB frames), per-peer flow control via `bufferedAmountLowThreshold`, SHA-256 per block and whole file (WebCrypto, streamed), ACK after write+verify, completed-block bitmap persisted in IndexedDB keyed by transfer capability, resume by bitmap exchange, out-of-order handling.
- Wire protocol documented in `docs/TRANSFER_PROTOCOL.md`: `HELLO, FILE_META, BITMAP, BLOCK, ACK, NACK, PAUSE, RESUME, DONE, ERROR` with binary framing (header + payload), versioned.
- Receiver storage adapters: File System Access API (Chromium), OPFS + Service Worker stream download (all engines), with capability detection shown before start (PRD §6.8). In-memory fallback is forbidden above 256 MB.
- Sender reads via `File.slice()` streaming; never full-file `arrayBuffer()`.
- `transfers` table and state machine; client reports state, verified bytes, route type; server validates transitions and authorizes by participant.
- Local history: on completion, failure, or cancellation, write an entry to the IndexedDB history store from Phase 1 on both sender and receiver; History shows it with transferred-vs-size.
- Keep screen on (Web), second part: extend the Phase 2 controller to hold during `CONNECTING`, `TRANSFERRING`, `RESUMING`, `RECONNECTING`, and verification on both sender and receiver, and release on completion, failure, pause, cancel, removal, and session end; screen-on pill on TR-6 and RX-6.
- UI: transfer dashboard (PRD §9 Active transfer) for one receiver; receive screens 8–13; pause/resume/cancel/retry; ETA with provisional/uncertain states (PRD §6.5); verification progress.
- Reconnect: on DataChannel close, re-signal, re-handshake with transfer capability, exchange bitmap, continue.

## Out of scope

More than one receiver per session in tests (schema already supports it), TURN forcing, Cloud, Android.

## Deliverables

- Engine with unit tests; protocol doc; `scripts/gen-fixture.sh`; `docs/runbooks/large-file-manual-test.md` for the 20 GB manual run.

## Tests to add

- Vitest: block scheduler, bitmap set/merge/missing, frame encode/decode fuzz, hasher streaming equality against Node `crypto`.
- Playwright `chromium-desktop` sender → receiver in each of `chromium-desktop`, `firefox-desktop`, `webkit-desktop`: 64 MB fixture on PR, hash equality; pause → resume; History on both contexts shows the entry after completion and after a page reload; with a stubbed `navigator.wakeLock`, the lock is held on both sides during the transfer and `release()` is called after completion, after pause, and after cancel, and re-requested after resume and after the tab becomes visible again; receiver reload mid-transfer → resume from bitmap with zero re-sent verified blocks (assert via engine debug counters exposed in test mode); checksum mismatch injected via test hook → block NACK and re-send; sender disconnect → receiver shows `DISCONNECTED` then resumes when sender returns.
- Mobile projects (`android-chrome`, `ios-safari`): capability detection page shows the correct matrix row and the 8 MB fixture transfer completes via OPFS path.
- Nightly: 2 GB fixture on `chromium-desktop` with memory ceiling assertion.

## CI changes

`e2e-web` adds the `transfer/p2p` spec folder; `nightly.yml` `large-file` job becomes real.

## Exit gate

All PR e2e transfers green across the three desktop engines and both mobile projects; nightly 2 GB passes at least once with the run linked in the report; protocol doc complete.
