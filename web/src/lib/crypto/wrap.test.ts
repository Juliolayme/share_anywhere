// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { generateAdk } from './adk';
import { hex } from './encoding';
import {
  WRAPPED_ADK_BYTES,
  WRAP_PURPOSES,
  blobSenderPublicKey,
  unwrapAdk,
  unwrapChain,
  wrapAdk,
  wrapChain,
} from './wrap';
import { forceX25519Backend, generateX25519, x25519FromSecret } from './x25519';

afterEach(() => forceX25519Backend(null));

const failed = { code: 'decrypt_failed' };

describe('ECIES wrap', () => {
  it('round-trips for each purpose with a fresh ephemeral key per blob', async () => {
    const adk = generateAdk(4).raw;
    const recipient = await generateX25519();
    for (const purpose of WRAP_PURPOSES) {
      const a = await wrapAdk(adk, recipient.publicKey, purpose, 4);
      const b = await wrapAdk(adk, recipient.publicKey, purpose, 4);
      expect(a).toHaveLength(WRAPPED_ADK_BYTES);
      expect(hex(blobSenderPublicKey(a))).not.toBe(hex(blobSenderPublicKey(b)));
      expect(hex(await unwrapAdk(a, recipient, purpose, 4))).toBe(hex(adk));
    }
  });

  it('rejects the wrong purpose, the wrong version, the wrong recipient, and tampering', async () => {
    const adk = generateAdk(2).raw;
    const recipient = await generateX25519();
    const blob = await wrapAdk(adk, recipient.publicKey, 'rotate', 2);
    await expect(unwrapAdk(blob, recipient, 'pair', 2)).rejects.toMatchObject(failed);
    await expect(unwrapAdk(blob, recipient, 'recovery', 2)).rejects.toMatchObject(failed);
    await expect(unwrapAdk(blob, recipient, 'rotate', 3)).rejects.toMatchObject(failed);
    await expect(unwrapAdk(blob, await generateX25519(), 'rotate', 2)).rejects.toMatchObject(failed);
    for (const at of [0, 33, 50, WRAPPED_ADK_BYTES - 1]) {
      const bad = Uint8Array.from(blob);
      bad[at] = (bad[at] ?? 0) ^ 0x80;
      await expect(unwrapAdk(bad, recipient, 'rotate', 2)).rejects.toThrow();
    }
    await expect(unwrapAdk(blob.subarray(1), recipient, 'rotate', 2)).rejects.toMatchObject({ code: 'invalid_input' });
    // @ts-expect-error unknown purpose
    await expect(wrapAdk(adk, recipient.publicKey, 'share', 2)).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('pairing: the sender device key leads the blob and must match the advertised key', async () => {
    const adk = generateAdk().raw;
    const newDevice = await generateX25519();
    const sender = await generateX25519();
    const blob = await wrapAdk(adk, newDevice.publicKey, 'pair', 1, { senderKey: sender });
    expect(hex(blobSenderPublicKey(blob))).toBe(hex(sender.publicKey));
    expect(hex(await unwrapAdk(blob, newDevice, 'pair', 1, { expectedSender: sender.publicKey }))).toBe(hex(adk));
    const other = await generateX25519();
    await expect(unwrapAdk(blob, newDevice, 'pair', 1, { expectedSender: other.publicKey })).rejects.toMatchObject({
      code: 'untrusted_sender',
    });
  });

  it('refuses low-order public keys', async () => {
    const adk = generateAdk().raw;
    const zero = new Uint8Array(32);
    const one = Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 : 0));
    for (const backend of ['webcrypto', 'noble'] as const) {
      forceX25519Backend(backend);
      for (const pub of [zero, one]) {
        await expect(wrapAdk(adk, pub, 'rotate', 1)).rejects.toMatchObject({ code: 'invalid_input' });
      }
    }
  });

  it('interoperates across the WebCrypto and @noble/curves backends', async () => {
    const adk = generateAdk(9).raw;
    const secret = crypto.getRandomValues(new Uint8Array(32));
    forceX25519Backend('noble');
    const rawPair = await x25519FromSecret(secret);
    expect(rawPair.privateKey.kind).toBe('raw');
    forceX25519Backend('webcrypto');
    const nativePair = await x25519FromSecret(secret);
    expect(nativePair.privateKey.kind).toBe('webcrypto');
    expect(hex(nativePair.publicKey)).toBe(hex(rawPair.publicKey));
    const blob = await wrapAdk(adk, rawPair.publicKey, 'recovery', 9);
    expect(hex(await unwrapAdk(blob, rawPair, 'recovery', 9))).toBe(hex(adk));
    forceX25519Backend('noble');
    const back = await wrapAdk(adk, nativePair.publicKey, 'rotate', 9);
    expect(hex(await unwrapAdk(back, nativePair, 'rotate', 9))).toBe(hex(adk));
  });
});

describe('chain', () => {
  it('opens ADK(v-1) with ADK(v) and only for version v', async () => {
    const v1 = generateAdk(1).raw;
    const v2 = generateAdk(2).raw;
    const blob = await wrapChain(v2, v1, 2);
    expect(blob).toHaveLength(60);
    expect(hex(await unwrapChain(blob, v2, 2))).toBe(hex(v1));
    await expect(unwrapChain(blob, v1, 2)).rejects.toMatchObject(failed);
    await expect(unwrapChain(blob, v2, 3)).rejects.toMatchObject(failed);
    await expect(wrapChain(v2, v1, 1)).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
