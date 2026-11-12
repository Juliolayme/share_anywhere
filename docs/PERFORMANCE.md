# Performance

Throughput per route and engine, and the memory ceilings each client is built to. All numbers come from loopback: the sender, receivers, backend and coturn share one machine, so they measure the transfer engine, the browser's WebRTC stack and storage, not a real network. Real networks will be slower and are untested (`KNOWN_LIMITATIONS.md` §4).

## 1. Throughput

Nightly job `throughput` (`.github/workflows/nightly.yml`, spec `web/e2e/nightly/throughput.spec.ts`): one 256 MiB file from a Chromium sender to one receiver, timed from Start receiving to the verified result (per-block and whole-file SHA-256 checks and storage writes included). Direct in each desktop engine; relay over UDP and over TLS (forced relay, CI coturn) in Chromium only, because Firefox ignores TURN servers on loopback. Each run uploads `throughput-<project>.json`.

| Route | Receiver engine | CI (GitHub-hosted, 4 vCPU) MiB/s | Local (container, 4 vCPU) MiB/s |
|---|---|---|---|
| Direct | Chromium | _see §1.1_ | 15.1 |
| Direct | Firefox | _see §1.1_ | — |
| Direct | WebKit | _see §1.1_ | — |
| Relay, UDP | Chromium | _see §1.1_ | 13.1 |
| Relay, TLS | Chromium | _see §1.1_ | 13.2 |

### 1.1 CI runs

Filled from the nightly artifacts (run link, date, commit).

### 1.2 Reading the numbers

- The ceiling is the engine's single DataChannel with 4 MiB blocks, an 8 MiB send buffer high-water mark (resume below 1 MiB), and SHA-256 over every block on both sides, plus the browser's DataChannel throughput on one host. Relay costs little on loopback; on real networks relay adds the round trip to the TURN server and its bandwidth.
- Five receivers share the sender's upload: the scheduler serves them fairly from one block cache (`docs/TRANSFER_PROTOCOL.md` §5.1). The nightly `five-receivers` job checks correctness, not speed.
- Android and iOS run the same engine design (shared vectors); their throughput is not benchmarked (emulator and simulator numbers would not mean much). The 192 MB process-death test and the iOS lifecycle tests only check correctness.

## 2. Memory ceilings

| Client | What bounds memory | Value | Where it is checked |
|---|---|---|---|
| Web sender | Block cache shared by all receivers | 64 MiB default (16 × 4 MiB), `VITE_BLOCK_CACHE_MB` at build time | `engine/cache.ts` unit tests |
| Web sender | DataChannel buffered amount per receiver | pause above 8 MiB, resume below 1 MiB | `engine/sender.ts` unit tests |
| Web, both sides | JS heap during a 2 GB transfer with a receiver reload | below 512 MiB (`CEILING`) | nightly `large-file` (Chromium) |
| Web receiver without OPFS | Whole file kept in memory | at most 256 MiB (`MEMORY_LIMIT`); larger receives are refused before they start | `storage/capability.test.ts` |
| Web receiver | Free browser storage | must cover the file (`navigator.storage.estimate()`), checked before the receive | `storage/capability.test.ts` |
| Android sender | Block cache; buffered amount | 64 MiB (`BlockCache.DEFAULT_BYTES`); 8 MiB / 1 MiB | `EngineTest.kt` |
| iOS sender | Block cache; buffered amount | 64 MiB (`BlockCache.defaultBytes`); 8 MiB / 1 MiB | `EngineTests.swift` |
| Receivers (all) | Writes go straight to the file or OPFS, block by block; the bitmap is persisted for resume | one block in flight per channel plus the receive queue | `large-file`, `ProcessDeathRestoreTest`, iOS terminate test |
| Backend | Never holds files; Cloud parts stream through in 4 MiB parts (`DefaultCloudPartSize`) | — | `backend/internal/transfers` cloud tests |
| Clipboard | Item size and count | 256 KB per item, 100 live items per account | API tests (`docs/API.md` §2.5) |
