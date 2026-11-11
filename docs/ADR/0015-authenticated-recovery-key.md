# ADR 0015: Authenticated recovery key and key checks in open tabs

Status: Accepted (Phase 5A QA round 3, 2026-11-11). Amends ADR 0014.

## Context

Phase 5A QA round 3 found one P0 and two gaps in the wording of ADR 0014.

- **P0-1 (unauthenticated recovery key).** Every rotation wraps ADK(v+1) to `recovery.public_key` from `GET /v1/keys`, and nothing authenticated that key. With ADR 0014 a ready client rotates by itself whenever the server says `rotation_due`, so a dishonest or write-compromised server could list a recovery key of its own, set `rotation_due`, and receive every new ADK with no user action. QA proved it against the client code with a stub server. ADR 0014's consequence "a dishonest server can hide `rotation_due` (denial of service, not disclosure)" was therefore wrong: disclosure was possible.
- **P2-3 (open tabs).** ADR 0014 says that, with clients re-proving on every key check, a device is left out of a rotation only if it stays offline across two rotations. On the Web, key checks ran only on load and on account actions, so a tab left open was as good as offline: it missed rotations and kept uploading history under the old key, which the server accepted.

## Decision

Contract wording (quoted from the frozen Phase 5A QA round 3 contract, sections H and I.3):

- **H.1 Setup signs the recovery key.** `POST /v1/keys/setup` adds required `recovery_key_signature` = Ed25519 with the signing key of version 1 over `"sa-recoverykey-v1|" + b64u(recovery_public_key)`. The server verifies it with the posted `verify_key` (`400 invalid_request` if malformed, `403 recovery_key_unverified` if it does not verify) and stores it (`account_keys.recovery_key_signature`, migration 0009; `NULL` = legacy).
- **H.2** `GET /v1/keys` `recovery` gains `signature` (the stored value; `null` for legacy). The recovery public key never changes after setup (no endpoint changes it).
- **H.3 Rotation precondition.** Before wrapping, the rotating device must hold ADK(1) (after chain import) and verify `recovery.signature` over the H.1 message with verify_key(1) derived from its own ADK(1). Missing or invalid: it refuses to rotate (`unverified`, key state `rejected`, no request sent). Legacy (`null`): `keys_legacy`.
- **H.4 Recovery.** `recoverWithPhrase` checks that the recovery public key derived from the phrase equals `recovery.public_key` and that `recovery.signature` verifies with `versions[1].verify_key`, after the anchor check. Setup computes the signature from the new ADK(1).
- **I.3 Open tabs and history uploads.** The Web runs a key check when the tab becomes visible and on the existing 30-second sync tick, at most one in flight and at most once per 30 seconds. The server requires `key_version == current` for new history entries (`POST /v1/history/entries`), otherwise `409 key_version_conflict`; the client runs a key check and retries once.

## Consequences

- A rotation wraps the new ADK only to keys the account's own ADK vouches for: device keys proven by the current version (ADR 0014) and the recovery key signed by version 1. A server that lists another recovery key gets no blob; the device shows the key problem state (`rejected`) and sends nothing.
- Correction to ADR 0014's consequences: a dishonest server could obtain new keys through a substituted recovery key until this ADR. With it, `rotation_due` gives the server denial of service only, with two documented residual risks: it can force repeated rotations (versions grow, devices offline across two rotations must pair again), and with a colluding departed device that held the current key it can re-list that device for an owed rotation, which excludes nothing by default. The Web client remembers the devices it revoked (IndexedDB) and excludes them until a rotation that excluded them succeeds (`docs/SECURITY_MODEL.md` §7).
- Correction to ADR 0014's "needs the device to stay offline across two rotations": on the Web that now holds for open tabs too (visible tabs check every 30 seconds and on becoming visible); a closed tab, a hidden tab, or a device that is off still needs pairing again after missing two rotations.
- History entries are always encrypted under the current version, so a device that missed a rotation cannot keep adding entries that devices paired later must decrypt with an older key.
- Accounts set up before migration 0009 have no recovery key signature and can no longer rotate (`keys_legacy`); this is pre-release development data, like the legacy rows of ADR 0012.
- Amends ADR 0014 (the two consequences corrected above). ADR 0012, ADR 0004, and the rest of ADR 0014 are unchanged. Byte layouts are pinned by the `recovery_key` vectors in `shared/protocol/schemas/clipboard-vectors.json`; the protocol is in `docs/CLIPBOARD_PROTOCOL.md` §1.
