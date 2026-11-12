import { ApiError } from '../../../lib/api/errors';
import { b64uEncode, equalBytes, fromHex } from '../../../lib/crypto/encoding';
import { generateX25519, type X25519KeyPair } from '../../../lib/crypto/x25519';
import type { SessionSocket, SocketEvent } from '../../../lib/ws/socket';
import { StreamHasher } from '../engine/hash';
import type { CloudApi, CloudObject } from './api';
import { openPart, unwrapKeys, type CloudKeyPayload, type ObjectKey } from './crypto';

export interface CloudReceiveDeps {
  sessionId: string;
  participantId: string;
  senderPid: string;
  api: CloudApi;
  socket: SessionSocket;
  /** Something changed (an object became ready, a key arrived, a pause lifted). */
  onChange: () => void;
  now?: () => number;
}

/** Why a cloud download stopped short. */
export class CloudDownloadError extends Error {
  constructor(readonly code: 'paused' | 'integrity' | 'unavailable' | 'network') {
    super(code);
  }
}

/**
 * The receiver side of Cloud Distribution (docs/TRANSFER_PROTOCOL.md §9): knows the session's objects (list and
 * CLOUD_UPDATED), asks the sender for their keys with an ephemeral X25519 key (CLOUD_KEY_REQUEST, at most every
 * 10 s while unanswered), and downloads and decrypts a file part by part, checking the whole-file SHA-256.
 */
export class CloudReceive {
  private objects = new Map<string, CloudObject>(); // by file id
  private keys = new Map<string, ObjectKey>(); // by object id
  private eph: X25519KeyPair | null = null;
  private lastAsk = 0;
  private unsub: (() => void) | null = null;
  private readonly now: () => number;

  constructor(private readonly d: CloudReceiveDeps) {
    this.now = d.now ?? Date.now;
  }

  /** Loads the session's objects (Cloud may be off on this server: then nothing is ever ready). */
  async start(): Promise<void> {
    this.unsub = this.d.socket.subscribe((e) => this.onSocket(e));
    try {
      for (const o of await this.d.api.list(this.d.sessionId)) this.objects.set(o.file_id, o);
    } catch {
      /* cloud_unavailable, or a transient error: CLOUD_UPDATED still arrives */
    }
    this.askForKeys();
  }

  dispose(): void {
    this.unsub?.();
  }

  /** A READY, unpaused object whose key this receiver holds. */
  ready(fileId: string): boolean {
    const o = this.objects.get(fileId);
    return !!o && o.status === 'READY' && !o.paused && this.keys.has(o.id);
  }

  object(fileId: string): CloudObject | undefined {
    return this.objects.get(fileId);
  }

  private onSocket(e: SocketEvent): void {
    if (e.session_id !== this.d.sessionId) return;
    if (e.type === 'CLOUD_UPDATED') {
      const o = e.object as CloudObject | undefined;
      if (!o) return;
      if (o.status === 'DELETED') this.objects.delete(o.file_id);
      else this.objects.set(o.file_id, o);
      this.askForKeys();
      this.d.onChange();
    } else if (e.type === 'CLOUD_KEY' && e.from === this.d.senderPid && this.eph) {
      void this.accept(e.payload as CloudKeyPayload);
    }
  }

  private async accept(payload: CloudKeyPayload): Promise<void> {
    if (!this.eph || !payload || typeof payload.public_key !== 'string' || !Array.isArray(payload.keys)) return;
    try {
      for (const k of await unwrapKeys(payload, this.eph, this.d.sessionId, this.d.participantId))
        this.keys.set(k.objectId, k);
    } catch {
      return;
    }
    this.d.onChange();
  }

  /** Asks the sender for keys when a READY object lacks one (rate-limited to once every 10 s). */
  askForKeys(): void {
    const missing = [...this.objects.values()].some((o) => o.status === 'READY' && !this.keys.has(o.id));
    if (!missing || this.now() - this.lastAsk < 10_000) return;
    this.lastAsk = this.now();
    void (async () => {
      this.eph ??= await generateX25519();
      this.d.socket.send({
        type: 'CLOUD_KEY_REQUEST',
        session_id: this.d.sessionId,
        to: this.d.senderPid,
        payload: { public_key: b64uEncode(this.eph.publicKey) },
      });
    })();
  }

  /**
   * Downloads and decrypts one file in order, writing each part at its offset; `progress` gets the plaintext bytes
   * written so far. Resolves once the whole-file SHA-256 matches; then tells the server this receiver has it.
   */
  async download(
    fileId: string,
    write: (offset: number, data: Uint8Array) => Promise<void>,
    progress: (bytes: number) => void,
    stopped: () => boolean,
  ): Promise<void> {
    const o = this.objects.get(fileId);
    const k = o && this.keys.get(o.id);
    if (!o || !k) throw new CloudDownloadError('unavailable');
    const hasher = new StreamHasher();
    for (let n = 0; n < o.part_count; n++) {
      if (stopped()) throw new CloudDownloadError('network');
      let stored: Uint8Array;
      try {
        stored = await this.d.api.getPart(o.id, n);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'cloud_budget_exhausted') throw new CloudDownloadError('paused');
        if (e instanceof ApiError && (e.status === 404 || e.status === 409))
          throw new CloudDownloadError('unavailable');
        throw new CloudDownloadError('network');
      }
      let plain: Uint8Array;
      try {
        plain = await openPart(k.key, o.id, n, o.part_count, stored);
      } catch {
        throw new CloudDownloadError('integrity');
      }
      const off = n * o.part_size;
      await write(off, plain);
      hasher.update(off, plain);
      progress(off + plain.byteLength);
    }
    if (!equalBytes(fromHex(hasher.hex()), k.sha256)) throw new CloudDownloadError('integrity');
    await this.d.api.received(o.id).catch(() => undefined);
  }
}
