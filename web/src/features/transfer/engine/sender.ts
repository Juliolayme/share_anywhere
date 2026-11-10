import { Bitmap } from './bitmap';
import { drained, type Channel } from './channel';
import {
  BLOCK_SIZE,
  DIGEST_BYTES,
  FLAG_FIRST,
  FLAG_LAST,
  FrameType,
  ProtocolError,
  blockCount,
  blockLength,
  dataPerFrame,
  decodeFrame,
  encodeFrame,
  jsonFrame,
  readJson,
  type DoneBody,
  type ErrorBody,
  type ErrorCode,
  type FileMeta,
  type HelloReceiver,
  type HelloSender,
  type NackBody,
} from './frame';
import { StreamHasher, digest } from './hash';

/** A file the sender reads in slices; never loaded whole (File.slice streaming). */
export interface FileSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function fileSource(file: Blob): FileSource {
  return {
    size: file.size,
    read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
  };
}

export interface SenderFile {
  index: number;
  fileId: string;
  transferId: string;
  name: string;
  size: number;
  mime: string;
  source: FileSource;
}

/**
 * Whole-file SHA-256 shared by every connection to every receiver: fed in order while blocks are read for
 * sending, and completed by a sequential pass when blocks were sent out of order.
 */
export class FileHash {
  private h = new StreamHasher();
  private result: Promise<string> | null = null;
  constructor(private readonly source: FileSource) {}

  feed(offset: number, data: Uint8Array): void {
    if (!this.result) this.h.update(offset, data);
  }

  value(): Promise<string> {
    this.result ??= (async () => {
      const chunk = BLOCK_SIZE;
      for (let off = this.h.position; off < this.source.size; off = this.h.position) {
        this.h.update(off, await this.source.read(off, Math.min(chunk, this.source.size - off)));
      }
      return this.h.hex();
    })();
    return this.result;
  }
}

export interface SenderCounters {
  blocksSent: number;
  /** Blocks sent again on this connection or after a reconnect although the receiver had verified them. */
  verifiedResent: number;
  nacks: number;
  bytesSent: number;
}

export interface SenderEvents {
  onAuthorized?(participantId: string): void;
  onProgress?(file: number, verifiedBytes: number): void;
  onFileDone?(file: number): void;
  onComplete?(): void;
  onPaused?(byPeer: boolean): void;
  onResumed?(byPeer: boolean): void;
  onError?(code: ErrorCode | 'closed', fatal: boolean, message?: string): void;
}

export interface SenderOptions {
  channel: Channel;
  sessionId: string;
  files: SenderFile[];
  hashes: Map<number, FileHash>;
  /** True when the participant is a JOINED receiver whose capability hash matches. */
  authorize(participantId: string, capability: string): Promise<boolean>;
  events?: SenderEvents;
  /** Unacknowledged blocks in flight (bounds the receiver's buffering). */
  window?: number;
  highWater?: number;
  lowWater?: number;
  maxRetries?: number;
  /** The sender no longer holds the files (tab reloaded): authorize, then end with file_unreadable. */
  unavailable?: boolean;
  /** Block size; protocol default 4 MiB (tests use smaller blocks). */
  blockSize?: number;
  /** Test hook: wait this long before each block (slows a transfer so tests can act mid-way). */
  pace?: { ms: number } | undefined;
  /** Test hook: corrupt the data of this many upcoming blocks after hashing them. */
  corrupt?: { blocks: number } | undefined;
}

interface Job {
  file: number;
  block: number;
}

/** One sender ↔ receiver connection (docs/TRANSFER_PROTOCOL.md §5). Create a new one per (re)connect. */
export class SenderConnection {
  readonly counters: SenderCounters = { blocksSent: 0, verifiedResent: 0, nacks: 0, bytesSent: 0 };
  participantId: string | null = null;
  private bitmaps = new Map<number, Bitmap>();
  private queue: Job[] = [];
  private inflight = new Set<string>();
  private retries = new Map<string, number>();
  private doneSent = new Set<number>();
  private confirmed = new Set<number>();
  private paused = false;
  private pumping = false;
  private closed = false;
  private readonly window: number;
  private readonly frameData: number;
  private readonly bs: number;

  constructor(private readonly o: SenderOptions) {
    this.window = o.window ?? 4;
    this.bs = o.blockSize ?? BLOCK_SIZE;
    this.frameData = dataPerFrame(o.channel.maxMessageSize);
    o.channel.bufferedAmountLowThreshold = o.lowWater ?? 1024 * 1024;
    o.channel.onmessage = (d) => void this.onMessage(d);
    o.channel.onclose = () => this.end('closed', false);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  verifiedBytes(file: number): number {
    const bm = this.bitmaps.get(file);
    const f = this.o.files.find((x) => x.index === file);
    if (!bm || !f) return 0;
    let n = 0;
    for (let i = 0; i < bm.size; i++) if (bm.has(i)) n += blockLength(f.size, i, this.bs);
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
    void this.pump();
  }

  cancel(): void {
    this.fail('cancelled', true, 'Cancelled by the sender.');
  }

  close(): void {
    this.closed = true;
    this.o.channel.close();
  }

  private send(buf: ArrayBuffer): void {
    if (this.closed || this.o.channel.readyState !== 'open') return;
    this.o.channel.send(buf);
  }

  private fail(code: ErrorCode, fatal: boolean, message?: string): void {
    const body: ErrorBody = { code, fatal, ...(message ? { message } : {}) };
    this.send(jsonFrame(FrameType.ERROR, body));
    this.end(code, fatal, message);
    if (fatal) void this.closeAfterFlush();
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

  private async onMessage(data: ArrayBuffer): Promise<void> {
    try {
      const f = decodeFrame(data);
      switch (f.type) {
        case FrameType.HELLO:
          return await this.onHello(readJson<HelloReceiver>(f));
        case FrameType.BITMAP:
          return this.onBitmap(f.file, f.payload);
        case FrameType.ACK:
          return this.onAck(f.file, f.block);
        case FrameType.NACK:
          readJson<NackBody>(f);
          return this.onNack(f.file, f.block);
        case FrameType.DONE: {
          const body = readJson<DoneBody>(f);
          if (body.ok) {
            this.confirmed.add(f.file);
            this.o.events?.onFileDone?.(f.file);
            if (this.confirmed.size === this.o.files.length) this.o.events?.onComplete?.();
          }
          return;
        }
        case FrameType.PAUSE:
          this.paused = true;
          return this.o.events?.onPaused?.(true);
        case FrameType.RESUME:
          this.paused = false;
          this.o.events?.onResumed?.(true);
          return void this.pump();
        case FrameType.ERROR: {
          const e = readJson<ErrorBody>(f);
          this.end(e.code, e.fatal, e.message);
          if (e.fatal) this.close();
          return;
        }
        default:
          throw new ProtocolError(`unexpected frame ${f.type} from a receiver`);
      }
    } catch (e) {
      this.fail('protocol', true, e instanceof Error ? e.message : String(e));
    }
  }

  private async onHello(h: HelloReceiver): Promise<void> {
    if (h.v !== 1 || h.role !== 'receiver' || h.session_id !== this.o.sessionId || !h.participant_id || !h.capability) {
      throw new ProtocolError('bad HELLO');
    }
    if (!(await this.o.authorize(h.participant_id, h.capability))) {
      this.fail('unauthorized', true, 'This device is not a joined receiver of the session.');
      return;
    }
    this.participantId = h.participant_id;
    if (this.o.unavailable) {
      this.fail('file_unreadable', true, 'The sender no longer has these files.');
      return;
    }
    this.o.events?.onAuthorized?.(h.participant_id);
    const hello: HelloSender = { v: 1, role: 'sender', session_id: this.o.sessionId };
    this.send(jsonFrame(FrameType.HELLO, hello));
    const meta: FileMeta = {
      files: this.o.files.map((f) => ({
        file: f.index,
        file_id: f.fileId,
        transfer_id: f.transferId,
        name: f.name,
        size: f.size,
        mime: f.mime,
        block_size: this.bs,
        block_count: blockCount(f.size, this.bs),
      })),
    };
    this.send(jsonFrame(FrameType.FILE_META, meta));
  }

  private onBitmap(file: number, bytes: Uint8Array): void {
    const f = this.o.files.find((x) => x.index === file);
    if (!this.participantId || !f) throw new ProtocolError('BITMAP before HELLO or for an unknown file');
    const bm = new Bitmap(blockCount(f.size, this.bs), bytes);
    this.bitmaps.set(file, bm);
    for (const block of bm.missing()) this.queue.push({ file, block });
    this.o.events?.onProgress?.(file, this.verifiedBytes(file));
    if (this.bitmaps.size === this.o.files.length) {
      this.queue.sort((a, b) => a.file - b.file || a.block - b.block);
      for (const x of this.o.files) void this.maybeDone(x.index);
      void this.pump();
    }
  }

  private onAck(file: number, block: number): void {
    const key = `${file}:${block}`;
    const bm = this.bitmaps.get(file);
    if (!bm || !this.inflight.delete(key)) throw new ProtocolError(`ACK for block ${key} that is not in flight`);
    bm.set(block);
    this.o.events?.onProgress?.(file, this.verifiedBytes(file));
    void this.maybeDone(file);
    void this.pump();
  }

  private onNack(file: number, block: number): void {
    const key = `${file}:${block}`;
    if (!this.inflight.delete(key)) throw new ProtocolError(`NACK for block ${key} that is not in flight`);
    this.counters.nacks++;
    const n = (this.retries.get(key) ?? 0) + 1;
    this.retries.set(key, n);
    if (n > (this.o.maxRetries ?? 3)) {
      this.fail('checksum_retries', true, `Block ${block} failed verification ${n} times.`);
      return;
    }
    this.queue.unshift({ file, block });
    void this.pump();
  }

  private async maybeDone(file: number): Promise<void> {
    const bm = this.bitmaps.get(file);
    if (!bm?.full || this.doneSent.has(file)) return;
    this.doneSent.add(file);
    const hash = this.o.hashes.get(file);
    if (!hash) throw new ProtocolError(`no hash state for file ${file}`);
    const body: DoneBody = { sha256: await hash.value() };
    this.send(jsonFrame(FrameType.DONE, body, file));
  }

  /** Sends queued blocks while the window and the channel buffer allow. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.closed && !this.paused && this.inflight.size < this.window) {
        const job = this.queue.shift();
        if (!job) break;
        if (this.o.pace?.ms) await new Promise((r) => setTimeout(r, this.o.pace?.ms));
        if (this.closed || this.paused) {
          this.queue.unshift(job);
          break;
        }
        if (this.bitmaps.get(job.file)?.has(job.block)) {
          this.counters.verifiedResent++; // never expected: the receiver's bitmap said it was missing
          continue;
        }
        await this.sendBlock(job);
      }
    } catch (e) {
      const unreadable = e instanceof DOMException || (e instanceof Error && e.name === 'NotReadableError');
      this.fail(unreadable ? 'file_unreadable' : 'protocol', true, e instanceof Error ? e.message : String(e));
    } finally {
      this.pumping = false;
    }
  }

  private async sendBlock({ file, block }: Job): Promise<void> {
    const f = this.o.files.find((x) => x.index === file);
    if (!f) throw new ProtocolError(`unknown file ${file}`);
    const len = blockLength(f.size, block, this.bs);
    const data = await f.source.read(block * this.bs, len);
    if (data.byteLength !== len)
      throw new DOMException('The file changed while it was being sent.', 'NotReadableError');
    this.o.hashes.get(file)?.feed(block * this.bs, data);
    const sum = await digest(data);
    if (this.o.corrupt && this.o.corrupt.blocks > 0) {
      this.o.corrupt.blocks--;
      data[0] = (data[0] ?? 0) ^ 0xff;
    }
    const key = `${file}:${block}`;
    this.inflight.add(key);
    const high = this.o.highWater ?? 8 * 1024 * 1024;
    for (let off = 0; off < len || off === 0;) {
      if (this.closed) return;
      if (this.o.channel.bufferedAmount > high) await drained(this.o.channel);
      const first = off === 0;
      const room = this.frameData - (first ? DIGEST_BYTES : 0);
      const n = Math.min(room, len - off);
      const last = off + n >= len;
      const payload = new Uint8Array((first ? DIGEST_BYTES : 0) + n);
      if (first) payload.set(sum, 0);
      payload.set(data.subarray(off, off + n), first ? DIGEST_BYTES : 0);
      this.send(
        encodeFrame({
          type: FrameType.BLOCK,
          flags: (first ? FLAG_FIRST : 0) | (last ? FLAG_LAST : 0),
          file,
          block,
          offset: off,
          payload,
        }),
      );
      this.counters.bytesSent += n;
      off += n;
      if (last) break;
    }
    this.counters.blocksSent++;
  }
}
