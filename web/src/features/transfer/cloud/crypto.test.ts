// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { b64uDecode, b64uEncode, fromHex, hex } from '../../../lib/crypto/encoding';
import { hkdfBytes } from '../../../lib/crypto/primitives';
import { generateX25519, x25519FromSecret, x25519SharedSecret } from '../../../lib/crypto/x25519';
import { openPart, sealPart, unwrapKeys, wrapKeys } from './crypto';

const v = JSON.parse(
  readFileSync(new URL('../../../../../shared/protocol/schemas/cloud-vectors.json', import.meta.url), 'utf8'),
) as {
  part: {
    object_id: string;
    part_count: number;
    file_sha256: string;
    key: string;
    parts: { n: number; nonce: string; plaintext: string; stored: string }[];
  };
  wrap: {
    session_id: string;
    receiver_participant_id: string;
    object_id: string;
    file_id: string;
    receiver_private: string;
    receiver_public_b64u: string;
    sender_private: string;
    sender_public_b64u: string;
    shared: string;
    info: string;
    wrap_key: string;
    nonce_b64u: string;
    wrapped_b64u: string;
  };
};

describe('cloud parts (shared vectors)', () => {
  it('seals each part byte for byte and opens it again', async () => {
    for (const p of v.part.parts) {
      const stored = await sealPart(
        fromHex(v.part.key),
        v.part.object_id,
        p.n,
        v.part.part_count,
        fromHex(p.plaintext),
        fromHex(p.nonce),
      );
      expect(hex(stored)).toBe(p.stored);
      const back = await openPart(fromHex(v.part.key), v.part.object_id, p.n, v.part.part_count, stored);
      expect(hex(back)).toBe(p.plaintext);
    }
  });

  it('refuses a part moved to another position, object or count, or altered', async () => {
    const p = v.part.parts[0];
    if (!p) throw new Error('no part vector');
    const key = fromHex(v.part.key);
    const stored = fromHex(p.stored);
    await expect(openPart(key, v.part.object_id, 1, v.part.part_count, stored)).rejects.toThrow();
    await expect(openPart(key, v.part.object_id, 0, v.part.part_count - 1, stored)).rejects.toThrow();
    await expect(openPart(key, '00000000-0000-4000-8000-000000000000', 0, v.part.part_count, stored)).rejects.toThrow();
    const bad = stored.slice();
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1;
    await expect(openPart(key, v.part.object_id, 0, v.part.part_count, bad)).rejects.toThrow();
  });
});

describe('cloud key wrap (shared vectors)', () => {
  const w = v.wrap;
  it('derives the same wrap key and blob', async () => {
    const receiver = await x25519FromSecret(fromHex(w.receiver_private));
    const sender = await x25519FromSecret(fromHex(w.sender_private));
    expect(b64uEncode(receiver.publicKey)).toBe(w.receiver_public_b64u);
    expect(b64uEncode(sender.publicKey)).toBe(w.sender_public_b64u);
    const shared = await x25519SharedSecret(sender.privateKey, receiver.publicKey);
    expect(hex(shared)).toBe(w.shared);
    const salt = new Uint8Array([...sender.publicKey, ...receiver.publicKey]);
    expect(hex(await hkdfBytes(shared, salt, w.info))).toBe(w.wrap_key);
    const payload = await wrapKeys(
      [{ objectId: w.object_id, fileId: w.file_id, key: fromHex(v.part.key), sha256: fromHex(v.part.file_sha256) }],
      w.receiver_public_b64u,
      w.session_id,
      w.receiver_participant_id,
      { sender, nonces: [b64uDecode(w.nonce_b64u)] },
    );
    expect(payload.public_key).toBe(w.sender_public_b64u);
    expect(payload.keys[0]?.wrapped).toBe(w.wrapped_b64u);
    const keys = await unwrapKeys(payload, receiver, w.session_id, w.receiver_participant_id);
    expect(keys.map((k) => [k.objectId, hex(k.key), hex(k.sha256)])).toEqual([
      [w.object_id, v.part.key, v.part.file_sha256],
    ]);
  });

  it('gives another receiver nothing', async () => {
    const receiver = await generateX25519();
    const other = await generateX25519();
    const payload = await wrapKeys(
      [{ objectId: w.object_id, fileId: w.file_id, key: fromHex(v.part.key), sha256: fromHex(v.part.file_sha256) }],
      b64uEncode(receiver.publicKey),
      w.session_id,
      w.receiver_participant_id,
    );
    expect(await unwrapKeys(payload, other, w.session_id, w.receiver_participant_id)).toEqual([]);
    expect(await unwrapKeys(payload, receiver, w.session_id, 'someone-else')).toEqual([]);
  });
});
