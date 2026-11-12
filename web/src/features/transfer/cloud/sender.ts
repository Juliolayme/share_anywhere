import { ApiError } from '../../../lib/api/errors';
import { fromHex } from '../../../lib/crypto/encoding';
import type { SessionSocket, SocketEvent } from '../../../lib/ws/socket';
import { StreamHasher } from '../engine/hash';
import type { FileSource } from '../engine/sender';
import { Observable } from '../runtime/observable';
import type { CloudApi, CloudObject } from './api';
import { newFileKey, sealPart, wrapKeys, type CloudKeyPayload, type ObjectKey } from './crypto';

export type CloudUploadStatus = 'waiting' | 'uploading' | 'ready' | 'paused' | 'failed';

export interface CloudUploadFile {
  fileId: string;
  name: string;
  size: number;
  /** Plaintext bytes uploaded (encrypted and stored). */
  uploaded: number;
  status: CloudUploadStatus;
}

export interface CloudUploadState {
  files: CloudUploadFile[];
  /** Catalog key of the last error that stopped the upload (budget, consent, network), or null. */
  error: string | null;
}

export interface CloudUploadDeps {
  sessionId: string;
  api: CloudApi;
  socket: SessionSocket;
  files: { fileId: string; name: string; size: number; source: FileSource }[];
  /** Waits between retries; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const ERROR_KEYS: Record<string, string> = {
  cloud_budget_exhausted: 'product.cloud_budget_exhausted',
  cloud_consent_required: 'product.cloud_consent_needed',
  cloud_requires_account: 'product.cloud_signin',
  cloud_unavailable: 'product.cloud_unavailable',
};

/**
 * The sender side of Cloud Distribution (docs/TRANSFER_PROTOCOL.md §9): distributes each file, encrypts it part by
 * part under a fresh file key and uploads the parts, seals the object, and answers receivers' CLOUD_KEY_REQUEST with
 * the keys wrapped to their ephemeral X25519 keys. Keys stay in this tab's memory.
 */
export class CloudUploader extends Observable<CloudUploadState> {
  private keys = new Map<string, ObjectKey>();
  private objects = new Map<string, CloudObject>();
  private unsub: (() => void) | null = null;
  private stopped = false;
  private resumeWaiters: (() => void)[] = [];
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly d: CloudUploadDeps) {
    super({
      files: d.files.map((f) => ({ fileId: f.fileId, name: f.name, size: f.size, uploaded: 0, status: 'waiting' })),
      error: null,
    });
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Uploads every file in order; resolves when all are sealed or the upload stopped. */
  async start(): Promise<void> {
    this.unsub = this.d.socket.subscribe((e) => this.onSocket(e));
    for (const f of this.d.files) {
      if (this.stopped) return;
      try {
        await this.upload(f);
      } catch (e) {
        const code = e instanceof ApiError ? e.code : 'network';
        this.patch(f.fileId, { status: 'failed' });
        this.update({ error: ERROR_KEYS[code] ?? 'product.cloud_upload_failed' });
        return;
      }
    }
  }

  dispose(): void {
    this.stopped = true;
    this.unsub?.();
    for (const w of this.resumeWaiters.splice(0)) w();
  }

  /** Keys this sender holds, for objects that are sealed. */
  get readyKeys(): ObjectKey[] {
    return [...this.keys.values()].filter((k) => this.objects.get(k.objectId)?.status === 'READY');
  }

  private patch(fileId: string, p: Partial<CloudUploadFile>): void {
    this.update((s) => ({ ...s, files: s.files.map((f) => (f.fileId === fileId ? { ...f, ...p } : f)) }));
  }

  private async upload(f: CloudUploadDeps['files'][number]): Promise<void> {
    let o = await this.d.api.distribute(f.fileId);
    this.objects.set(o.id, o);
    if (o.status !== 'UPLOADING') {
      // An object from an earlier page whose key this tab no longer holds: receivers keep P2P for this file.
      this.patch(f.fileId, { status: 'failed' });
      return;
    }
    this.patch(f.fileId, { status: 'uploading' });
    const key = newFileKey();
    const hasher = new StreamHasher();
    for (let n = 0; n < o.part_count; n++) {
      if (this.stopped) return;
      const off = n * o.part_size;
      const len = Math.max(0, Math.min(o.part_size, f.size - off));
      const plain = len > 0 ? await f.source.read(off, len) : new Uint8Array(0);
      hasher.update(off, plain);
      const stored = await sealPart(key, o.id, n, o.part_count, plain);
      o = await this.putWithRetry(f.fileId, o.id, n, stored);
      this.patch(f.fileId, { uploaded: off + len, status: 'uploading' });
    }
    o = await this.d.api.seal(o.id);
    this.objects.set(o.id, o);
    this.keys.set(o.id, { objectId: o.id, fileId: f.fileId, key, sha256: fromHex(hasher.hex()) });
    this.patch(f.fileId, { status: 'ready', uploaded: f.size });
  }

  /** One part: retries network errors with backoff; waits out a used-up budget until CLOUD_UPDATED lifts it. */
  private async putWithRetry(fileId: string, objectId: string, n: number, stored: Uint8Array): Promise<CloudObject> {
    for (let attempt = 0; ; attempt++) {
      try {
        const o = await this.d.api.putPart(objectId, n, stored);
        if (this.state_.error) this.update({ error: null });
        return o;
      } catch (e) {
        if (this.stopped) throw e;
        if (e instanceof ApiError && e.code === 'cloud_budget_exhausted') {
          this.patch(fileId, { status: 'paused' });
          this.update({ error: ERROR_KEYS[e.code] ?? null });
          await new Promise<void>((resolve) => {
            this.resumeWaiters.push(resolve);
            void this.sleep(60_000).then(resolve);
          });
          continue;
        }
        if (e instanceof ApiError && e.status < 500 && e.status !== 429) throw e;
        await this.sleep(Math.min(15_000, 1000 * 2 ** Math.min(attempt, 4)));
      }
    }
  }

  private onSocket(e: SocketEvent): void {
    if (e.session_id !== this.d.sessionId) return;
    if (e.type === 'CLOUD_UPDATED') {
      const o = e.object as CloudObject | undefined;
      if (!o) return;
      this.objects.set(o.id, o);
      if (!o.paused) for (const w of this.resumeWaiters.splice(0)) w();
    } else if (e.type === 'CLOUD_KEY_REQUEST' && typeof e.from === 'string') {
      // The server relays this only from a JOINED receiver of this session (docs/API.md §4).
      const pub = (e.payload as { public_key?: unknown } | undefined)?.public_key;
      const keys = this.readyKeys;
      if (typeof pub !== 'string' || keys.length === 0) return;
      void this.answer(e.from, pub, keys);
    }
  }

  private async answer(to: string, receiverPublic: string, keys: ObjectKey[]): Promise<void> {
    let payload: CloudKeyPayload;
    try {
      payload = await wrapKeys(keys, receiverPublic, this.d.sessionId, to);
    } catch {
      return; // a malformed or low-order public key
    }
    this.d.socket.send({ type: 'CLOUD_KEY', session_id: this.d.sessionId, to, payload });
  }
}
