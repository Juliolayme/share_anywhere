# Transfer protocol (version 1)

How two clients move files peer to peer once a receiver is `JOINED` (PRD §6.1–§6.5, `docs/ARCHITECTURE.md` §5). The server never sees file bytes: it relays signaling, issues TURN credentials, and keeps transfer records (`docs/API.md` §2.3). Web implements this in `web/src/features/transfer/engine/`; Android (Phase 6) and iOS (Phase 7) must reproduce `shared/protocol/schemas/transfer-vectors.json` exactly.

## 1. Connection

- One `RTCPeerConnection` per receiver. The **receiver offers**: it knows when it is ready (save target chosen) and when it needs to reconnect (reload, dropped link). The sender answers any `OFFER` from a `JOINED` receiver and replaces that receiver's previous connection.
- Signaling (`OFFER`, `ANSWER`, `ICE_CANDIDATE`) goes over the WebSocket, addressed by participant ID (`docs/API.md` §4). ICE servers come from `POST /v1/turn/credentials` (TURN URIs plus a `stun:` URI on the same host and port). Every signaling payload carries the connection id (`conn`) of the offer it belongs to. The receiver trickles candidates right after its `OFFER`, so the answering side must keep `ICE_CANDIDATE` messages that arrive before it has applied that offer as its remote description (buffer per receiver and `conn`, bounded; flush in order after `setRemoteDescription`, then add later ones directly) and ignore candidates for any other `conn`. Dropping them loses the host and server-reflexive candidates.
- The receiver creates one data channel named `sa-transfer/1`: ordered, reliable, `binaryType = "arraybuffer"`. Every message on it is one frame (§2).
- DTLS authenticates the channel to the two endpoints whose SDP the server relayed; HELLO (§3) then proves the receiver holds its transfer capability. Both happen on **every** connect and reconnect.

## 2. Frames

Each message is a 20-byte header followed by the payload. All integers are unsigned big-endian.

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | Version, `1`. Any other value ends the connection |
| 1 | 1 | Type (table below) |
| 2 | 2 | Flags. `BLOCK`: `FIRST = 1` (payload starts with the 32-byte SHA-256 of the whole block), `LAST = 2` (last frame of the block) |
| 4 | 4 | File index from `FILE_META`; `0xFFFFFFFF` when the frame is not about a file |
| 8 | 4 | Block index |
| 12 | 4 | Byte offset of this frame's data inside the block (`BLOCK` only) |
| 16 | 4 | Payload length; must equal the message length − 20 |

| Type | Name | Direction | Payload |
|---|---|---|---|
| 1 | `HELLO` | both | JSON (§3) |
| 2 | `FILE_META` | sender → receiver | JSON `{files: [{file, file_id, transfer_id, name, size, mime, block_size, block_count}]}` |
| 3 | `BITMAP` | receiver → sender | Raw completed-block bitmap of one file (§4) |
| 4 | `BLOCK` | sender → receiver | Block data (after the digest on the `FIRST` frame) |
| 5 | `ACK` | receiver → sender | Empty. Block written, verified, and its bitmap bit persisted |
| 6 | `NACK` | receiver → sender | JSON `{reason}` with `checksum`, `length` or `storage`; the sender re-sends the block |
| 7 | `PAUSE` | both | Empty |
| 8 | `RESUME` | both | Empty |
| 9 | `DONE` | both | JSON `{sha256}` from the sender when every block of a file is acknowledged; JSON `{sha256, ok}` from the receiver after it re-reads and hashes the stored file |
| 10 | `ERROR` | both | JSON `{code, message?, fatal}`; codes `unauthorized`, `protocol`, `storage_full`, `storage_error`, `file_unreadable`, `checksum_retries`, `file_hash_mismatch`, `cancelled`. A fatal error closes the channel after the frame is flushed |

Sizes:

- **Block:** 4 MiB (4,194,304 bytes); the last block of a file is shorter. An empty file has zero blocks.
- **Frame:** at most 64 KiB including the header, and never more than the peer's `RTCSctpTransport.maxMessageSize`, so each frame carries `min(65536, maxMessageSize) − 20` payload bytes. The `FIRST` frame also carries the 32-byte block digest.

A malformed frame, a frame out of order, or a frame of the wrong direction is a `protocol` error.

## 3. Handshake and authentication

1. When the channel opens, the receiver sends `HELLO {v: 1, role: "receiver", session_id, participant_id, capability}`.
2. The sender authorizes it:

   - the participant is a `JOINED` receiver in `GET /v1/sessions/{id}/transfers` → `peers`;
   - hex SHA-256 of `capability` equals that peer's `capability_hash`.

   On failure it sends `ERROR unauthorized` (fatal).
3. The sender replies `HELLO {v: 1, role: "sender", session_id}`, then `FILE_META`. Each entry's `transfer_id` is this receiver's transfer record for that file.
4. The receiver prepares storage for each file, loads its persisted bitmap (§4), and sends one `BITMAP` per file. Blocks may only follow once the sender has every bitmap.

**The transfer capability:**

- It is 256 bits: HMAC-SHA-256 of participant ID, device ID and join time under a server key, base64url, from `backend/internal/sharing/member.go`.
- Only that `JOINED` receiver sees it, in `TransferList.capability`. The sender only sees its SHA-256.
- Remove, Block, Leave, and a rejoin (new join time) invalidate it.
- A receiver resuming a paused transfer over REST must present it (`docs/API.md` §2.3).

## 4. Bitmap and resume

- Bit *i* is block *i*, least significant bit first: block *i* is done when `(bytes[i >> 3] >> (i & 7)) & 1`.
- The bitmap is `ceil(block_count / 8)` bytes, and bits past the last block must be zero. 20 GB / 4 MiB = 5,120 blocks → 640 bytes.
- The receiver persists the bitmap after each block is written and verified, **before** it sends `ACK`. On Web it lives in IndexedDB, keyed by the transfer capability's hash and the transfer ID; the partial file lives in OPFS.
- Lifecycle: a finished file stays in browser storage for 24 hours so it can be downloaded again; progress records untouched for 24 hours are removed with their staging files, staging files no record refers to are removed after an hour (`storage/sweep.ts`, once per tab), partial data is removed when a transfer fails, is cancelled, or the receiver is removed, and a folder copy removes its staging file at once.
- A receiver first checks that `FILE_META` matches the server's files (ID and size, the size the save screen checked); a mismatch is a `protocol` error.
- On every connect the receiver sends its persisted bitmap. The sender schedules exactly the missing blocks, in ascending order per file, files in `FILE_META` order. Holes and out-of-order completion are normal. A block that arrives although its bit is already set is acknowledged and counted as a duplicate; the resume tests assert the count stays zero.

## 5. Block flow, flow control, verification

- **Window:**
  - The sender keeps at most 4 unacknowledged blocks in flight, so the receiver buffers at most 4 × 4 MiB.
  - Within the window it sends frames while `bufferedAmount` is under 8 MiB, then waits for `bufferedamountlow` (threshold 1 MiB).
  - The sender reads each block with `File.slice()`, never the whole file.
- **Per block:**
  - The sender hashes the block (SHA-256, WebCrypto) and sends the digest on the `FIRST` frame.
  - The receiver assembles the frames, checks the length and the digest, writes at `block × block_size`, flushes, sets and persists the bitmap bit, then sends `ACK`.
  - On a mismatch it sends `NACK`. The sender re-sends the block up to 3 times, then fails with `checksum_retries`.
- **Per file:**
  - The sender feeds blocks in order into a streaming whole-file SHA-256 while it reads them, and finishes any gap with one sequential pass.
  - When every block is acknowledged, the sender sends `DONE {sha256}`.
  - The receiver re-reads the stored file in order (the "verifying" state), hashes it, and answers `DONE {sha256, ok}`. A mismatch is `file_hash_mismatch` (fatal; the sender's file changed while it was being sent).
- **Pause and resume:** either side may send `PAUSE`. The sender stops scheduling new blocks, and blocks already in flight complete. `RESUME` continues. Pause is also recorded on the server (`POST /v1/transfers/{id}/pause`) so the other side learns it even without a channel.
- **Cancel:** `ERROR cancelled` (fatal) plus `POST /v1/transfers/{id}/cancel`.

### 5.1 Several receivers

- Each receiver has its own connection, window, flow control, bitmap and retry state, so a slow or disconnected receiver only waits on its own channel; it never holds back the others.
- The sender's connections share one **block cache** (least recently used blocks evicted beyond a byte budget, 64 MiB by default, `VITE_BLOCK_CACHE_MB` at build time). A block is read from the file and hashed once while it is cached, and concurrent requests for the same block share that read. Receivers moving together read the file once; a receiver that falls far behind reads its blocks again instead of holding memory for everyone. Cached blocks are never modified in place.
- The whole-file hash state is shared too: it is fed only by actual reads, in file order where it can be.
- Pause, resume, Remove and Block act on one receiver; Stop all cancels every transfer; Close session ends the session for everyone (`docs/ARCHITECTURE.md` §4.4). The group ETA follows the slowest active receiver (PRD §6.5).

## 6. Reconnect

When the channel closes without a fatal error (reconnect window: 2 minutes to make a first connection, 10 minutes to get one back; after that the receiver shows "Couldn't reach the sender" with Retry, and nothing is reported as failed):

1. The receiver reports `DISCONNECTED`.
2. The receiver re-offers with backoff (1 s doubling to 15 s, ±25 % jitter so receivers that lost the sender together do not redial in step), reporting `RECONNECTING`. The WebSocket reconnects separately with its own jittered backoff and a fresh one-time ticket each time (signaling re-authentication).
3. Once the channel opens, it repeats the handshake (§3), reports `RESUMING`, then `TRANSFERRING` once blocks flow.

The sender has the same 10-minute window per receiver: a receiver that is connecting or reconnecting with no open channel for 10 minutes shows **Offline** on TR-5 and TR-6 ("Lost contact. They can reconnect while this page stays open") and no longer holds the sender's screen on. The record keeps its state, and a new connection from that receiver resumes as above.

The sender keeps its file handles and whole-file hash state across reconnects, but a sender page reload loses the file handles: the transfer then fails for that receiver and the sender must create a new session. Route migration (Phase 8) uses the same path.

## 7. State reporting

- The receiver reports transfer state and verified bytes with `POST /v1/transfers/{id}/report`:
  - on every state change;
  - at most every 2 s while bytes flow;
  - `COMPLETED` only after `DONE ok`.
- The sender reports nothing except its own pause, resume, and cancel actions; the server refuses reports from the sender (`403 receiver_only`). Leaving `PAUSED` for an active state goes through `resume`, which checks a receiver's capability, so a report cannot skip it (`409 use_resume`). Reports never pass through `PAUSED` on the way elsewhere. The one report allowed out of `PAUSED` is `COMPLETED` from the receiver with every byte verified (Pause pressed during the final hash check, or the sender paused then); a reconnect while paused starts the new connection paused on both sides.
- The route (`direct` or `relay`) comes from the selected ICE candidate pair (`getStats()`: `relay` when either local or remote candidate type is `relay`).
- The keep-awake controller holds the screen on while any transfer is `CONNECTING`, `TRANSFERRING`, `RESUMING`, `RECONNECTING`, or verifying (`docs/ARCHITECTURE.md` §7).

## 8. Test vectors

`shared/protocol/schemas/transfer-vectors.json` holds:

- the exact bytes of one frame of each type;
- bitmap encodings;
- block and whole-file SHA-256 for a deterministic data pattern (`byte[i] = (i × 31 + 7) mod 256`);
- frame counts for two message-size limits.

`web/src/features/transfer/engine/vectors.test.ts` regenerates and compares it. Change it only together with a protocol version bump.
