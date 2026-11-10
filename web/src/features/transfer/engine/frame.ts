/**
 * Wire format of the Share Anywhere transfer protocol, version 1 (docs/TRANSFER_PROTOCOL.md §2).
 *
 * Every DataChannel message is one frame: a 20-byte big-endian header followed by the payload.
 *   0  u8   version (1)
 *   1  u8   type (FrameType)
 *   2  u16  flags (BLOCK: FIRST = 1, LAST = 2)
 *   4  u32  file index (NO_FILE when not about a file)
 *   8  u32  block index
 *   12 u32  byte offset inside the block (BLOCK only)
 *   16 u32  payload length (must equal message length − 20)
 */
export const VERSION = 1;
export const HEADER_BYTES = 20;
export const NO_FILE = 0xffffffff;
export const BLOCK_SIZE = 4 * 1024 * 1024;
export const FRAME_BYTES = 64 * 1024; // largest message we send, header included
export const DIGEST_BYTES = 32;

export enum FrameType {
  HELLO = 1,
  FILE_META = 2,
  BITMAP = 3,
  BLOCK = 4,
  ACK = 5,
  NACK = 6,
  PAUSE = 7,
  RESUME = 8,
  DONE = 9,
  ERROR = 10,
}

export const FLAG_FIRST = 1;
export const FLAG_LAST = 2;

export interface Frame {
  type: FrameType;
  flags: number;
  file: number;
  block: number;
  offset: number;
  payload: Uint8Array;
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

const JSON_TYPES = new Set([FrameType.HELLO, FrameType.FILE_META, FrameType.NACK, FrameType.DONE, FrameType.ERROR]);
const EMPTY_TYPES = new Set([FrameType.ACK, FrameType.PAUSE, FrameType.RESUME]);
const u32 = (n: number, what: string) => {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new ProtocolError(`${what} out of range`);
  return n;
};

export function encodeFrame(f: Partial<Frame> & { type: FrameType }): ArrayBuffer {
  const payload = f.payload ?? new Uint8Array(0);
  const buf = new ArrayBuffer(HEADER_BYTES + payload.byteLength);
  const v = new DataView(buf);
  v.setUint8(0, VERSION);
  v.setUint8(1, f.type);
  v.setUint16(2, f.flags ?? 0);
  v.setUint32(4, u32(f.file ?? NO_FILE, 'file'));
  v.setUint32(8, u32(f.block ?? 0, 'block'));
  v.setUint32(12, u32(f.offset ?? 0, 'offset'));
  v.setUint32(16, payload.byteLength);
  new Uint8Array(buf, HEADER_BYTES).set(payload);
  return buf;
}

/** Decodes one message; throws ProtocolError on anything malformed (the caller ends the connection). */
export function decodeFrame(data: ArrayBuffer | Uint8Array): Frame {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < HEADER_BYTES) throw new ProtocolError('frame shorter than its header');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint8(0) !== VERSION) throw new ProtocolError(`unsupported protocol version ${v.getUint8(0)}`);
  const type = v.getUint8(1) as FrameType;
  if (!(type in FrameType) || type < FrameType.HELLO || type > FrameType.ERROR)
    throw new ProtocolError(`unknown frame type ${type}`);
  const length = v.getUint32(16);
  if (length !== bytes.byteLength - HEADER_BYTES) throw new ProtocolError('payload length does not match the message');
  const payload = bytes.subarray(HEADER_BYTES);
  if (EMPTY_TYPES.has(type) && length !== 0) throw new ProtocolError('control frame with a payload');
  const flags = v.getUint16(2);
  if (type === FrameType.BLOCK && flags & FLAG_FIRST && length < DIGEST_BYTES)
    throw new ProtocolError('first block frame without its digest');
  return { type, flags, file: v.getUint32(4), block: v.getUint32(8), offset: v.getUint32(12), payload };
}

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

export function jsonFrame(type: FrameType, body: unknown, file = NO_FILE, block = 0): ArrayBuffer {
  if (!JSON_TYPES.has(type)) throw new ProtocolError(`frame type ${type} does not carry JSON`);
  return encodeFrame({ type, file, block, payload: enc.encode(JSON.stringify(body)) });
}

export function readJson<T>(f: Frame): T {
  if (!JSON_TYPES.has(f.type)) throw new ProtocolError(`frame type ${f.type} does not carry JSON`);
  try {
    return JSON.parse(dec.decode(f.payload)) as T;
  } catch {
    throw new ProtocolError('invalid JSON payload');
  }
}

/** Payload bytes available for block data in one frame, given the channel's message limit. */
export function dataPerFrame(maxMessageSize: number | null | undefined): number {
  const limit = Math.min(FRAME_BYTES, maxMessageSize && maxMessageSize > 0 ? maxMessageSize : FRAME_BYTES);
  return limit - HEADER_BYTES;
}

/** Number of blocks of a file. An empty file has zero blocks and is complete once announced. */
export function blockCount(size: number, blockSize = BLOCK_SIZE): number {
  return Math.ceil(size / blockSize);
}

export function blockLength(size: number, index: number, blockSize = BLOCK_SIZE): number {
  return Math.min(blockSize, size - index * blockSize);
}

// Message bodies (JSON payloads).
export interface HelloReceiver {
  v: 1;
  role: 'receiver';
  session_id: string;
  participant_id: string;
  capability: string;
}
export interface HelloSender {
  v: 1;
  role: 'sender';
  session_id: string;
}
export interface FileMetaEntry {
  file: number;
  file_id: string;
  transfer_id: string;
  name: string;
  size: number;
  mime: string;
  block_size: number;
  block_count: number;
}
export interface FileMeta {
  files: FileMetaEntry[];
}
export interface NackBody {
  reason: 'checksum' | 'length' | 'storage';
}
export interface DoneBody {
  sha256: string;
  ok?: boolean;
}
export type ErrorCode =
  | 'unauthorized'
  | 'protocol'
  | 'storage_full'
  | 'storage_error'
  | 'file_unreadable'
  | 'checksum_retries'
  | 'file_hash_mismatch'
  | 'cancelled';
export interface ErrorBody {
  code: ErrorCode;
  message?: string;
  fatal: boolean;
}
