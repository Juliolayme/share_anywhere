import { Bitmap } from './bitmap';
import { drained, type Channel } from './channel';
import {
  DIGEST_BYTES,
  FLAG_FIRST,
  FLAG_LAST,
  FrameType,
  ProtocolError,
  blockCount,
  blockLength,
  decodeFrame,
  encodeFrame,
  jsonFrame,
  readJson,
  type DoneBody,
  type ErrorBody,
  type ErrorCode,
  type FileMeta,
  type FileMetaEntry,
  type HelloReceiver,
  type HelloSender,
  type NackBody,
} from './frame';
import { digest, equalBytes, hashStream } from './hash';

/** Where received bytes go (OPFS, File System Access, or memory for small files). */
export interface Sink {
  write(offset: number, data: Uint8Array): Promise<void>;
  read(offset: number, length: number): Promise<Uint8Array>;
  /** Makes writes durable before the block is acknowledged. */
  flush(): Promise<void>;
}

/** A file prepared for receiving: its sink and the persisted bitmap (empty on a first connect). */
export interface PreparedFile {
  sink: Sink;
  bitmap: Bitmap;
  /** Persists the bitmap after a block is written and verified (IndexedDB, keyed by transfer capability). */
  persist(bitmap: Bitmap): Promise<void>;
  /** True when this file was already verified end to end on an earlier connection. */
  verified?: boolean;
}

export interface ReceiverCounters {
  blocksReceived: number;
  /** Blocks that arrived although this device had already verified them (must stay 0 across a resume). */
  duplicates: number;
  nacksSent: number;
}

export interface ReceiverEvents {
  onMeta?(files: FileMetaEntry[]): void;
  onProgress?(file: number, verifiedBytes: number): void;
  onVerifying?(file: number, hashedBytes: number): void;
  onFileDone?(file: number, ok: boolean): void;
  onComplete?(): void;
  onPaused?(byPeer: boolean): void;
  onResumed?(byPeer: boolean): void;
  onError?(code: ErrorCode | 'closed', fatal: boolean, message?: string): void;
}

export interface ReceiverOptions {
  channel: Channel;
  hello: HelloReceiver;
  prepare(entry: FileMetaEntry): Promise<PreparedFile>;
  events?: ReceiverEvents;
  /** Most blocks assembled at once; more means the sender ignored the window. */
  maxAssembling?: number;
}

interface Assembly {
  digest: Uint8Array;
  data: Uint8Array;
  received: number;
}

/** One receiver ↔ sender connection (docs/TRANSFER_PROTOCOL.md §5). Create a new one per (re)connect. */
export class ReceiverConnection {
  readonly counters: ReceiverCounters = { blocksReceived: 0, duplicates: 0, nacksSent: 0 };
  private files = new Map<number, { entry: FileMetaEntry; prep: PreparedFile }>();
  private assembling = new Map<string, Assembly>();
  private chain: Promise<void> = Promise.resolve();
  private done = new Set<number>();
  private paused = false;
  private closed = false;
  private muted = false;
  private authorized = false;

  constructor(private readonly o: ReceiverOptions) {
    o.channel.onmessage = (d) => this.onMessage(d);
    o.channel.onclose = () => this.end('closed', false);
  }

  /** Call once the channel is open. */
  start(): void {
    this.send(jsonFrame(FrameType.HELLO, this.o.hello));
  }

  get isPaused(): boolean {
    return this.paused;
  }

  verifiedBytes(file: number): number {
    const f = this.files.get(file);
    if (!f) return 0;
    let n = 0;
    for (let i = 0; i < f.prep.bitmap.size; i++)
      if (f.prep.bitmap.has(i)) n += blockLength(f.entry.size, i, f.entry.block_size);
    return n;
  }

  pause(): void {
    if (this.paused || this.closed) return;
    this.paused = true;
    this.send(encodeFrame({ type: FrameType.PAUSE }));
    this.o.events?.onPaused?.(false);
  }

  resume(): void {
    if (!this.paused || this.closed) return;
    this.paused = false;
    this.send(encodeFrame({ type: FrameType.RESUME }));
    this.o.events?.onResumed?.(false);
  }

  cancel(): void {
    this.fail('cancelled', true, 'Cancelled by the receiver.');
  }

  close(): void {
    this.closed = true;
    this.o.channel.close();
  }

  /** The page is going away: send nothing more (no ERROR from storage torn down with the page), close nothing. */
  mute(): void {
    this.muted = true;
  }

  private send(buf: ArrayBuffer): void {
    if (this.closed || this.muted || this.o.channel.readyState !== 'open') return;
    this.o.channel.send(buf);
  }

  private fail(code: ErrorCode, fatal: boolean, message?: string): void {
    const body: ErrorBody = { code, fatal, ...(message ? { message } : {}) };
    this.send(jsonFrame(FrameType.ERROR, body));
    this.end(code, fatal, message);
    if (fatal && !this.muted) void this.closeAfterFlush();
  }

  /** Lets the ERROR frame leave before the channel closes. */
  private async closeAfterFlush(): Promise<void> {
    await drained(this.o.channel);
    setTimeout(() => this.o.channel.close(), 100);
  }

  private end(code: ErrorCode | 'closed', fatal: boolean, message?: string): void {
    if (this.closed && code === 'closed') return;
    this.closed = this.closed || fatal || code === 'closed';
    this.o.events?.onError?.(code, fatal, message);
  }

  /** Frames are handled in arrival order; block completion (hash, write, persist, ACK) is serialized. */
  private onMessage(data: ArrayBuffer): void {
    let f;
    try {
      f = decodeFrame(data);
    } catch (e) {
      this.fail('protocol', true, (e as Error).message);
      return;
    }
    if (f.type === FrameType.BLOCK) {
      try {
        this.onBlockFrame(f.file, f.block, f.offset, f.flags, f.payload);
      } catch (e) {
        this.fail('protocol', true, (e as Error).message);
      }
      return;
    }
    const frame = f;
    this.chain = this.chain
      .then(() => this.onControl(frame))
      .catch((e: unknown) => {
        if (e instanceof ProtocolError) this.fail('protocol', true, e.message);
        else if (e instanceof DOMException && e.name === 'QuotaExceededError')
          this.fail('storage_full', true, e.message);
        else this.fail('storage_error', true, e instanceof Error ? e.message : String(e));
      });
  }

  private async onControl(f: ReturnType<typeof decodeFrame>): Promise<void> {
    switch (f.type) {
      case FrameType.HELLO: {
        const h = readJson<HelloSender>(f);
        if (h.v !== 1 || h.role !== 'sender' || h.session_id !== this.o.hello.session_id)
          throw new ProtocolError('bad HELLO');
        this.authorized = true;
        return;
      }
      case FrameType.FILE_META: {
        if (!this.authorized) throw new ProtocolError('FILE_META before HELLO');
        const meta = readJson<FileMeta>(f);
        for (const e of meta.files) {
          if (e.block_count !== blockCount(e.size, e.block_size) || e.block_size <= 0)
            throw new ProtocolError('inconsistent FILE_META');
        }
        this.o.events?.onMeta?.(meta.files);
        for (const entry of meta.files) {
          const prep = await this.o.prepare(entry);
          if (prep.bitmap.size !== entry.block_count) throw new ProtocolError('stored bitmap does not match the file');
          this.files.set(entry.file, { entry, prep });
          if (prep.verified) this.done.add(entry.file);
          this.send(encodeFrame({ type: FrameType.BITMAP, file: entry.file, payload: prep.bitmap.bytes }));
          this.o.events?.onProgress?.(entry.file, this.verifiedBytes(entry.file));
        }
        return;
      }
      case FrameType.DONE: {
        const body = readJson<DoneBody>(f);
        return this.verifyFile(f.file, body.sha256);
      }
      case FrameType.PAUSE:
        this.paused = true;
        return this.o.events?.onPaused?.(true);
      case FrameType.RESUME:
        this.paused = false;
        return this.o.events?.onResumed?.(true);
      case FrameType.ERROR: {
        const e = readJson<ErrorBody>(f);
        this.end(e.code, e.fatal, e.message);
        if (e.fatal) this.close();
        return;
      }
      default:
        throw new ProtocolError(`unexpected frame ${f.type} from a sender`);
    }
  }

  private onBlockFrame(file: number, block: number, offset: number, flags: number, payload: Uint8Array): void {
    const key = `${file}:${block}`;
    const target = this.files.get(file);
    // FILE_META is processed on the control chain; block frames can only follow BITMAP, which follows it.
    if (!target) throw new ProtocolError(`block for unknown file ${file}`);
    const len = blockLength(target.entry.size, block, target.entry.block_size);
    if (block >= target.entry.block_count) throw new ProtocolError(`block ${block} outside the file`);
    let a = this.assembling.get(key);
    let data = payload;
    if (flags & FLAG_FIRST) {
      if (offset !== 0 || a) throw new ProtocolError('unexpected first frame');
      if (this.assembling.size >= (this.o.maxAssembling ?? 8)) throw new ProtocolError('too many blocks in flight');
      a = { digest: payload.slice(0, DIGEST_BYTES), data: new Uint8Array(len), received: 0 };
      this.assembling.set(key, a);
      data = payload.subarray(DIGEST_BYTES);
    }
    if (!a || offset !== a.received || offset + data.byteLength > len)
      throw new ProtocolError('block frame out of place');
    a.data.set(data, offset);
    a.received += data.byteLength;
    if (!(flags & FLAG_LAST)) return;
    this.assembling.delete(key);
    const done = a;
    this.chain = this.chain
      .then(() => this.completeBlock(file, block, len, done))
      .catch((e: unknown) => {
        const full = e instanceof DOMException && e.name === 'QuotaExceededError';
        this.fail(full ? 'storage_full' : 'storage_error', true, e instanceof Error ? e.message : String(e));
      });
  }

  private async completeBlock(file: number, block: number, len: number, a: Assembly): Promise<void> {
    const target = this.files.get(file);
    if (!target) throw new ProtocolError(`block for unknown file ${file}`);
    const { entry, prep } = target;
    this.counters.blocksReceived++;
    if (prep.bitmap.has(block)) {
      this.counters.duplicates++;
      this.send(encodeFrame({ type: FrameType.ACK, file, block }));
      return;
    }
    const nack = (reason: NackBody['reason']) => {
      this.counters.nacksSent++;
      this.send(jsonFrame(FrameType.NACK, { reason } satisfies NackBody, file, block));
    };
    if (a.received !== len) return nack('length');
    if (!equalBytes(await digest(a.data), a.digest)) return nack('checksum');
    await prep.sink.write(block * entry.block_size, a.data);
    await prep.sink.flush();
    prep.bitmap.set(block);
    await prep.persist(prep.bitmap);
    this.send(encodeFrame({ type: FrameType.ACK, file, block })); // only after write + verify + persist
    this.o.events?.onProgress?.(file, this.verifiedBytes(file));
  }

  private async verifyFile(file: number, expected: string): Promise<void> {
    const t = this.files.get(file);
    if (!t) throw new ProtocolError(`DONE for unknown file ${file}`);
    if (!t.prep.bitmap.full) throw new ProtocolError('DONE before every block was verified');
    if (this.done.has(file)) {
      this.send(jsonFrame(FrameType.DONE, { sha256: expected, ok: true } satisfies DoneBody, file));
      this.finish(file, true);
      return;
    }
    const actual = await hashStream(
      t.entry.size,
      (off, n) => t.prep.sink.read(off, n),
      (n) => this.o.events?.onVerifying?.(file, n),
    );
    const ok = actual === expected;
    this.send(jsonFrame(FrameType.DONE, { sha256: actual, ok } satisfies DoneBody, file));
    if (!ok) {
      this.fail('file_hash_mismatch', true, 'The received file does not match the sender’s file.');
      this.o.events?.onFileDone?.(file, false);
      return;
    }
    this.finish(file, true);
  }

  private finish(file: number, ok: boolean): void {
    this.done.add(file);
    this.o.events?.onFileDone?.(file, ok);
    if (this.done.size === this.files.size) this.o.events?.onComplete?.();
  }
}
