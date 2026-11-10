import type { SessionSocket, SocketEvent } from '../../../lib/ws/socket';
import type { HistoryStore, HistoryStatus } from '../../history/store/history-store';
import type { SessionView } from '../../sharing/api';
import { Bitmap } from '../engine/bitmap';
import { fromDataChannel } from '../engine/channel';
import { Throughput } from '../engine/eta';
import { ProtocolError, type ErrorCode, type FileMetaEntry } from '../engine/frame';
import { sha256Hex } from '../engine/hash';
import { ReceiverConnection, type PreparedFile, type Sink } from '../engine/receiver';
import { copyIntoFolder, downloadFile, folderPermission } from '../storage/folder';
import { memorySink, type MemorySink } from '../storage/memory';
import { openOpfsSink, opfsFile, removeOpfs, type OpfsSink } from '../storage/opfs';
import { progressKey, type Progress, type ProgressStore, type SaveTarget } from '../storage/progress-store';
import type { Route, TransferStatus, TransfersApi } from './api';
import { Observable } from './observable';
import { Reporter } from './reporter';
import { CHANNEL_LABEL, rtcConfig, selectedRoute, watchPeer, type CandidatePayload, type SdpPayload } from './rtc';
import { terminal } from './transitions';

export type RxPhase =
  | 'loading'
  | 'choose'
  | 'permission'
  | 'connecting'
  | 'transferring'
  | 'paused'
  | 'reconnecting'
  | 'verifying'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  /** Could not reach the sender within the reconnect window; Retry starts again (not final, nothing reported as failed). */
  | 'unreachable';

export interface RxFile {
  index: number;
  fileId: string;
  transferId: string;
  name: string;
  size: number;
  mime: string;
  verified: number;
  done: boolean;
  failed: boolean;
  /** Name used in the chosen folder once copied. */
  savedAs?: string;
}

export interface LogLine {
  at: number;
  key: string;
  params?: Record<string, string | number>;
}

export interface RxState {
  phase: RxPhase;
  files: RxFile[];
  total: number;
  verified: number;
  route: Route | null;
  bytesPerSecond: number;
  eta: number | null;
  /** Catalog key of the failure, when phase is failed. */
  error: string | null;
  target: SaveTarget | null;
  log: LogLine[];
  /** Engine counters folded in from finished connections (tests read them through `counters`). */
  duplicates: number;
  blocksReceived: number;
  nacksSent: number;
  /** Verified bytes found in saved progress when this page loaded (resume after a reload). */
  resumedBytes: number;
  /** This receiver's security words (compared with the sender's screen). */
  words: string[];
}

export interface ReceiverDeps {
  sessionId: string;
  api: TransfersApi;
  view: () => Promise<SessionView>;
  socket: SessionSocket;
  store: ProgressStore;
  history: HistoryStore | null;
  createPeer?: (cfg: RTCConfiguration) => RTCPeerConnection;
}

const ACTIVE: RxPhase[] = ['connecting', 'transferring', 'reconnecting', 'verifying'];
export const rxActive = (p: RxPhase) => ACTIVE.includes(p);
const FINAL: RxPhase[] = ['completed', 'partial', 'failed', 'cancelled'];
export const rxFinal = (p: RxPhase) => FINAL.includes(p);

const ERROR_KEYS: Partial<Record<ErrorCode, string>> = {
  unauthorized: 'product.tx_err_unauthorized',
  storage_full: 'product.tx_err_storage_full',
  storage_error: 'product.tx_err_storage',
  file_unreadable: 'product.tx_err_sender_files',
  checksum_retries: 'product.tx_err_checksum',
  file_hash_mismatch: 'product.tx_err_checksum',
  protocol: 'product.tx_err_protocol',
};

/** Drives one receive (docs/TRANSFER_PROTOCOL.md): storage, the peer connection, resume, reports, history. */
export class ReceiverController extends Observable<RxState> {
  private reporter: Reporter;
  private capability = '';
  private capHash = '';
  private senderPid = '';
  private senderName = '';
  private pc: RTCPeerConnection | null = null;
  private conn: ReceiverConnection | null = null;
  private connId = '';
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private sampler: ReturnType<typeof setInterval> | null = null;
  private sinks = new Map<number, Sink>();
  private throughput = new Throughput();
  private unsub: (() => void) | null = null;
  private stopped = false;
  private hadData = false;
  private historyWritten = false;
  private initialized: Promise<void> | null = null;
  private participantId = '';
  /** When the current run of failed attempts started (null while a channel is open). */
  private downSince: number | null = null;
  private everOpened = false;
  /** ICE and connection diagnostics (memory only). */
  readonly diag: string[] = [];
  /** Per-file completion work (folder copy, records), serialized so completion sees every file. */
  private fileWork: Promise<void> = Promise.resolve();

  /** The sender's display name (for headings), once loaded. */
  get senderDisplayName(): string {
    return this.senderName;
  }

  constructor(private readonly d: ReceiverDeps) {
    super({
      phase: 'loading',
      files: [],
      total: 0,
      verified: 0,
      route: null,
      bytesPerSecond: 0,
      eta: null,
      error: null,
      target: null,
      log: [],
      duplicates: 0,
      blocksReceived: 0,
      nacksSent: 0,
      resumedBytes: 0,
      words: [],
    });
    this.reporter = new Reporter(d.api);
    // The server can only be moved out of PAUSED by the resume action. If a report finds the transfer paused
    // while nobody paused it here, resume it with the capability; if the user (or the sender) paused, stay.
    this.reporter.resume = async (id) => {
      if (this.state_.phase === 'paused') return null;
      return this.d.api.action(id, 'resume', this.capability).catch(() => null);
    };
  }

  /** Loads the session, transfer records and any saved progress; resumes when a save target is known. */
  init(): Promise<void> {
    this.initialized ??= this.load();
    return this.initialized;
  }

  private async load(): Promise<void> {
    const [view, list] = await Promise.all([this.d.view(), this.d.api.list(this.d.sessionId)]);
    this.senderPid = view.sender?.participant_id ?? '';
    this.participantId = view.me?.id ?? '';
    this.senderName = view.sender?.display_name ?? '';
    this.capability = list.capability ?? '';
    this.capHash = await sha256Hex(this.capability);
    const byFile = new Map(list.transfers.map((t) => [t.file_id, t]));
    const files: RxFile[] = [];
    for (const [index, f] of (view.files ?? []).entries()) {
      const t = byFile.get(f.id);
      if (!t) continue;
      this.reporter.seed(t.id, t.status, t.verified_bytes);
      const saved = await this.d.store.get(progressKey(this.capHash, t.id));
      files.push({
        index,
        fileId: f.id,
        transferId: t.id,
        name: f.name,
        size: f.size,
        mime: f.mime,
        verified: saved ? verifiedOf(saved) : 0,
        done: t.status === 'COMPLETED' || !!saved?.verified,
        failed: t.status === 'FAILED' || t.status === 'CANCELLED',
        ...(saved?.savedToFolder ? { savedAs: saved.name } : {}),
      });
    }
    const total = files.reduce((a, f) => a + f.size, 0);
    this.update({
      words: view.me?.security_words ?? [],
      files,
      total,
      verified: sum(files),
      resumedBytes: files.filter((f) => !f.done).reduce((a, f) => a + f.verified, 0),
    });
    this.unsub = this.d.socket.subscribe((e) => this.onSocket(e));
    const statuses = list.transfers.map((t) => t.status);
    if (statuses.length && statuses.every((s) => s === 'COMPLETED')) return this.finish('completed');
    if (statuses.length && statuses.every(terminal))
      return this.finish(statuses.some((s) => s === 'COMPLETED') ? 'partial' : 'cancelled');
    const target = await this.d.store.getTarget(this.d.sessionId);
    if (!target) return this.update({ phase: 'choose' });
    this.update({ target });
    if (target.mode === 'folder' && target.folder && !(await folderPermission(target.folder)))
      return this.update({ phase: 'permission' });
    if (statuses.some((s) => s === 'PAUSED')) return this.update({ phase: 'paused' });
    this.connect();
  }

  /** The user chose where to save (RX-5b), or granted folder access again after a reload. */
  async start(target: SaveTarget): Promise<void> {
    await this.init();
    await this.d.store.putTarget(target);
    this.update({ target });
    this.log('product.log_receiving', { n: this.state_.files.length });
    if (this.pausedOnServer()) return this.update({ phase: 'paused' });
    this.connect();
  }

  /** The sender (or this receiver before a reload) paused: stay paused rather than resume on our own. */
  private pausedOnServer(): boolean {
    return this.open().some((f) => this.reporter.current(f.transferId) === 'PAUSED');
  }

  pause(): void {
    if (rxFinal(this.state_.phase) || this.state_.phase === 'paused') return;
    // Unreachable: nothing to pause. Verifying: every byte is here, only the local hash check remains.
    if (this.state_.phase === 'unreachable' || this.state_.phase === 'verifying') return;
    // No open channel yet (connecting or reconnecting): stop dialling until Resume.
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.conn) this.conn.pause();
    else this.teardown();
    this.update({ phase: 'paused', eta: null });
    for (const f of this.open())
      void this.d.api
        .action(f.transferId, 'pause')
        .catch(() => undefined)
        .then((t) => t && this.reporter.seed(f.transferId, t.status, t.verified_bytes));
  }

  async resume(): Promise<void> {
    if (this.state_.phase !== 'paused') return;
    for (const f of this.open()) {
      try {
        const t = await this.d.api.action(f.transferId, 'resume', this.capability);
        this.reporter.seed(f.transferId, t.status, t.verified_bytes);
      } catch {
        /* the next report retries the resume action through the reporter's hook */
      }
    }
    if (this.conn && this.pc?.connectionState === 'connected') {
      this.conn.resume();
      this.update({ phase: 'transferring' });
      for (const f of this.open()) void this.reporter.state(f.transferId, 'TRANSFERRING', f.verified);
    } else {
      this.update({ phase: 'connecting' }); // connect() stays put while paused
      this.attempt = 0;
      this.downSince = null; // a pause does not use up the reconnect window
      this.connect();
    }
  }

  /** After the reconnect window ran out: try again from the start of a new window. */
  retry(): void {
    if (this.state_.phase !== 'unreachable') return;
    this.attempt = 0;
    this.downSince = null;
    if (this.pausedOnServer()) return this.update({ phase: 'paused' });
    this.connect();
  }

  async cancel(): Promise<void> {
    this.conn?.cancel();
    await Promise.all(this.open().map((f) => this.d.api.action(f.transferId, 'cancel').catch(() => undefined)));
    await this.cleanupStaging(false);
    this.finish('cancelled');
  }

  /** Saves a finished file: download for browser storage, nothing to do for a folder (already copied). */
  async save(index: number): Promise<void> {
    const f = this.state_.files.find((x) => x.index === index);
    if (!f?.done) return;
    const sink = this.sinks.get(index);
    if (sink && 'blob' in sink) return downloadFile((sink as MemorySink).blob(f.mime), f.name);
    downloadFile(await opfsFile(f.transferId, f.name, f.mime), f.name);
  }

  get counters() {
    const live = this.conn?.counters;
    return {
      duplicates: this.state_.duplicates + (live?.duplicates ?? 0),
      blocksReceived: this.state_.blocksReceived + (live?.blocksReceived ?? 0),
      nacksSent: this.state_.nacksSent + (live?.nacksSent ?? 0),
      resumedBytes: this.state_.resumedBytes,
    };
  }

  /**
   * The page is going away (reload, tab close, navigation to another site). Close the connection first, so
   * errors from storage being torn down with the page are never sent to the sender or reported as a failure;
   * the saved bitmap lets the next load resume.
   */
  suspend(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.teardown();
  }

  /** The page came back from the back-forward cache: reconnect if the transfer was still running. */
  wake(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (rxActive(this.state_.phase) || this.state_.phase === 'reconnecting') this.connect();
  }

  dispose(): void {
    this.stopped = true;
    this.unsub?.();
    this.teardown();
    this.reporter.dispose();
  }

  // --- connection ---

  private connect(): void {
    if (this.stopped || rxFinal(this.state_.phase) || this.state_.phase === 'paused') return;
    this.teardown();
    this.downSince ??= Date.now();
    const reconnecting = this.hadData || this.attempt > 0;
    this.update({ phase: reconnecting ? 'reconnecting' : 'connecting' });
    for (const f of this.open())
      void this.reporter.state(f.transferId, reconnecting ? 'RECONNECTING' : 'CONNECTING', f.verified);
    void this.dial();
  }

  private async dial(): Promise<void> {
    const connId = crypto.randomUUID();
    this.connId = connId;
    const cfg = await rtcConfig(this.d.api, this.d.sessionId);
    if (this.connId !== connId || this.stopped) return;
    const pc = this.d.createPeer ? this.d.createPeer(cfg) : new RTCPeerConnection(cfg);
    this.pc = pc;
    watchPeer(pc, this.diag);
    this.diag.push(`dial ${connId.slice(0, 8)} servers ${cfg.iceServers?.length ?? 0}`);
    const dc = pc.createDataChannel(CHANNEL_LABEL, { ordered: true });
    pc.onicecandidate = (e) => {
      const payload: CandidatePayload = { conn: connId, candidate: e.candidate ? e.candidate.toJSON() : null };
      this.d.socket.send({ type: 'ICE_CANDIDATE', session_id: this.d.sessionId, to: this.senderPid, payload });
    };
    let grace: ReturnType<typeof setTimeout> | null = null;
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (grace) clearTimeout(grace);
      grace = null;
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.lost();
      // Some engines stay "disconnected" when the peer goes away; treat 4 s of it as lost.
      else if (pc.connectionState === 'disconnected') grace = setTimeout(() => this.pc === pc && this.lost(), 4000);
    };
    dc.onopen = () => {
      if (this.pc !== pc) return;
      if (this.openTimer) clearTimeout(this.openTimer);
      this.downSince = null;
      this.everOpened = true;
      this.attach(dc, pc);
    };
    this.openTimer = setTimeout(() => this.pc === pc && this.lost(), 20_000);
    await pc.setLocalDescription(await pc.createOffer());
    const payload: SdpPayload = { conn: connId, sdp: pc.localDescription?.toJSON() ?? { type: 'offer' } };
    if (!this.d.socket.send({ type: 'OFFER', session_id: this.d.sessionId, to: this.senderPid, payload })) this.lost();
  }

  private attach(dc: RTCDataChannel, pc: RTCPeerConnection): void {
    const conn = new ReceiverConnection({
      channel: fromDataChannel(dc, pc),
      hello: {
        v: 1,
        role: 'receiver',
        session_id: this.d.sessionId,
        participant_id: this.participantId,
        capability: this.capability,
      },
      prepare: (e) => this.prepare(e),
      events: {
        onProgress: (file, bytes) => this.onProgress(file, bytes),
        onVerifying: () => this.state_.phase !== 'paused' && this.update({ phase: 'verifying' }),
        onFileDone: (file, ok) => {
          this.fileWork = this.fileWork.then(() => this.onFileDone(file, ok)).catch(() => undefined);
        },
        onComplete: () => {
          this.fileWork = this.fileWork.then(() => this.onAllDone()).catch(() => undefined);
        },
        onPaused: () => this.update({ phase: 'paused' }),
        onResumed: () => this.update({ phase: 'transferring' }),
        onError: (code, fatal) => this.onConnError(code, fatal),
      },
    });
    this.conn = conn;
    conn.start();
    if (this.state_.phase === 'paused') conn.pause();
    this.sampler = setInterval(() => this.sample(), 500);
    void selectedRoute(pc).then((route) => {
      if (!route) return;
      this.reporter.route = route;
      this.update({ route });
      this.log(route === 'relay' ? 'product.log_relay_plain' : 'product.log_direct');
    });
  }

  private async prepare(e: FileMetaEntry): Promise<PreparedFile> {
    const f = this.state_.files.find((x) => x.transferId === e.transfer_id);
    // The sender's FILE_META must describe exactly the files the server announced (and the save screen sized).
    if (!f || f.fileId !== e.file_id || f.size !== e.size)
      throw new ProtocolError('FILE_META does not match the session’s files');
    const mode = this.state_.target?.mode ?? 'opfs';
    const key = progressKey(this.capHash, f.transferId);
    if (mode === 'memory') {
      const sink = memorySink(e.size);
      this.sinks.set(f.index, sink);
      return { sink, bitmap: new Bitmap(e.block_count), persist: async () => undefined };
    }
    const saved = await this.d.store.get(key);
    const sink: OpfsSink = await openOpfsSink(f.transferId, e.size);
    this.sinks.set(f.index, sink);
    const base: Progress =
      saved && saved.blockSize === e.block_size && saved.size === e.size
        ? saved
        : {
            key,
            sessionId: this.d.sessionId,
            transferId: f.transferId,
            name: f.name,
            size: e.size,
            blockSize: e.block_size,
            bitmap: new Bitmap(e.block_count).bytes,
            staging: f.transferId,
            verified: false,
            updatedAt: Date.now(),
          };
    const bitmap = new Bitmap(e.block_count, base.bitmap);
    return {
      sink,
      bitmap,
      verified: base.verified,
      persist: async (bm) => {
        base.bitmap = bm.bytes.slice();
        base.updatedAt = Date.now();
        await this.d.store.put(base);
      },
    };
  }

  private onProgress(file: number, bytes: number): void {
    const f = this.state_.files.find((x) => x.index === file);
    if (!f) return;
    const files = this.state_.files.map((x) => (x.index === file ? { ...x, verified: bytes } : x));
    const phase: RxPhase =
      this.state_.phase === 'paused' ? 'paused' : this.state_.phase === 'verifying' ? 'verifying' : 'transferring';
    if (!this.hadData && bytes > 0 && this.state_.phase === 'reconnecting') this.log('product.log_reconnected_plain');
    if (phase === 'transferring' && this.state_.phase !== 'transferring') {
      for (const x of files.filter((y) => !y.done && !y.failed))
        void this.reporter.state(x.transferId, 'TRANSFERRING', x.verified);
    }
    this.hadData = this.hadData || bytes > 0;
    this.attempt = 0;
    this.update({ files, verified: sum(files), phase });
    if (!f.done) this.reporter.progress(f.transferId, bytes);
  }

  private async onFileDone(file: number, ok: boolean): Promise<void> {
    const f = this.state_.files.find((x) => x.index === file);
    if (!f) return;
    if (!ok) {
      this.update({ files: this.state_.files.map((x) => (x.index === file ? { ...x, failed: true } : x)) });
      await this.reporter.state(f.transferId, 'FAILED', f.verified);
      return;
    }
    let savedAs: string | undefined;
    const target = this.state_.target;
    const saved = await this.d.store.get(progressKey(this.capHash, f.transferId));
    if (saved) await this.d.store.put({ ...saved, verified: true, updatedAt: Date.now() });
    if (target?.mode === 'folder' && target.folder && !saved?.savedToFolder) {
      try {
        savedAs = await copyIntoFolder(target.folder, await opfsFile(f.transferId, f.name, f.mime));
        if (saved)
          await this.d.store.put({
            ...saved,
            verified: true,
            savedToFolder: true,
            name: savedAs,
            updatedAt: Date.now(),
          });
        await removeOpfs(f.transferId);
      } catch {
        this.update({ error: 'product.tx_err_folder' });
      }
    }
    this.update({
      files: this.state_.files.map((x) =>
        x.index === file ? { ...x, done: true, verified: x.size, ...(savedAs ? { savedAs } : {}) } : x,
      ),
    });
    await this.reporter.state(f.transferId, 'COMPLETED', f.size);
  }

  private async onAllDone(): Promise<void> {
    this.log('product.log_integrity_ok', { n: this.state_.files.length });
    const files = this.state_.files;
    this.finish(files.every((f) => f.done) ? 'completed' : files.some((f) => f.done) ? 'partial' : 'failed');
    this.teardown();
  }

  private onConnError(code: ErrorCode | 'closed', fatal: boolean): void {
    if (this.stopped || rxFinal(this.state_.phase)) return;
    if (code === 'cancelled') {
      void this.cleanupStaging(false);
      return this.finish('cancelled');
    }
    if (fatal) {
      for (const f of this.open()) void this.reporter.state(f.transferId, 'FAILED', f.verified);
      void this.cleanupStaging(true); // keep files that finished, drop partial data and its bitmaps
      this.update({ error: ERROR_KEYS[code as ErrorCode] ?? 'product.tx_err_protocol' });
      return this.finish(this.state_.files.some((f) => f.done) ? 'partial' : 'failed');
    }
    this.lost();
  }

  /** The channel dropped or never opened: report DISCONNECTED and retry with backoff (1 s doubling to 15 s). */
  private lost(): void {
    if (this.stopped || rxFinal(this.state_.phase) || this.retryTimer) return;
    const paused = this.state_.phase === 'paused';
    this.teardown();
    if (this.hadData) this.log('product.log_connection_lost_plain');
    for (const f of this.open()) void this.reporter.state(f.transferId, paused ? 'PAUSED' : 'DISCONNECTED', f.verified);
    if (paused) return;
    // Reconnect window: 2 minutes to make a first connection, 10 minutes to get one back.
    const window = this.everOpened ? 10 * 60_000 : 2 * 60_000;
    if (this.downSince !== null && Date.now() - this.downSince > window) {
      return this.update({ phase: 'unreachable', eta: null });
    }
    this.update({ phase: 'reconnecting' });
    const delay = Math.min(15_000, 1000 * 2 ** this.attempt);
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private teardown(): void {
    if (this.openTimer) clearTimeout(this.openTimer);
    if (this.sampler) clearInterval(this.sampler);
    this.openTimer = null;
    this.sampler = null;
    if (this.conn) {
      const c = this.conn.counters;
      this.update({
        duplicates: this.state_.duplicates + c.duplicates,
        blocksReceived: this.state_.blocksReceived + c.blocksReceived,
        nacksSent: this.state_.nacksSent + c.nacksSent,
      });
    }
    this.conn = null;
    const pc = this.pc;
    this.pc = null;
    this.connId = '';
    pc?.close();
  }

  private onSocket(e: SocketEvent): void {
    const payload = e.payload as SdpPayload | CandidatePayload | undefined;
    if (e.type === 'ANSWER' && e.from === this.senderPid && payload?.conn === this.connId && this.pc) {
      this.diag.push('answer');
      void this.pc.setRemoteDescription((payload as SdpPayload).sdp).catch((err: unknown) => {
        this.diag.push(`answer-error ${String(err)}`);
        this.lost();
      });
    } else if (e.type === 'ICE_CANDIDATE' && e.from === this.senderPid && payload?.conn === this.connId && this.pc) {
      const c = (payload as CandidatePayload).candidate;
      this.diag.push(`remote ${c ? (c.candidate ?? '').split(' ').slice(4, 8).join(' ') : 'end'}`);
      if (c) void this.pc.addIceCandidate(c).catch((err: unknown) => this.diag.push(`add-error ${String(err)}`));
    } else if (e.type === 'TRANSFER_UPDATED') {
      const t = e.transfer as { id: string; status: TransferStatus; verified_bytes: number } | undefined;
      if (t) this.onServerUpdate(t.id, t.status, t.verified_bytes);
    } else if (e.type === 'SESSION_CLOSED' || e.type === 'SESSION_EXPIRED') {
      if (!rxFinal(this.state_.phase)) this.endedElsewhere();
    } else if (e.type === 'ERROR' && e.code === 'peer_offline' && this.pc) {
      this.lost();
    }
  }

  /** The sender paused, resumed or cancelled through the server (also works while the channel is down). */
  private onServerUpdate(id: string, status: TransferStatus, verified: number): void {
    const f = this.state_.files.find((x) => x.transferId === id);
    if (!f) return;
    this.reporter.seed(id, status, verified);
    if (status === 'PAUSED' && (rxActive(this.state_.phase) || this.state_.phase === 'unreachable')) {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.update({ phase: 'paused', eta: null });
    }
    if (status === 'RESUMING' && this.state_.phase === 'paused') {
      if (this.conn && this.pc?.connectionState === 'connected') this.update({ phase: 'transferring' });
      else {
        this.update({ phase: 'connecting' });
        this.connect();
      }
    }
    if (status === 'CANCELLED' && !rxFinal(this.state_.phase)) {
      this.conn?.close();
      void this.cleanupStaging(false);
      this.finish('cancelled');
    }
  }

  /** Called by the page when this receiver was removed or blocked, or the session ended. */
  endedElsewhere(): void {
    this.teardown();
    const files = this.state_.files;
    void this.cleanupStaging(true);
    this.finish(files.every((f) => f.done) ? 'completed' : files.some((f) => f.done) ? 'partial' : 'cancelled');
  }

  private sample(): void {
    const now = performance.now();
    this.throughput.sample(this.state_.verified, now);
    const e = this.throughput.estimate(this.state_.verified, this.state_.total, this.state_.phase === 'reconnecting');
    this.update({ bytesPerSecond: e.bytesPerSecond, eta: e.seconds });
  }

  private open(): RxFile[] {
    return this.state_.files.filter((f) => !f.done && !f.failed);
  }

  private async cleanupStaging(keepDone: boolean): Promise<void> {
    for (const f of this.state_.files) {
      if (keepDone && f.done) continue;
      await removeOpfs(f.transferId);
      // Without its file a bitmap would resume against nothing and end in a hash mismatch.
      if (keepDone) await this.d.store.remove(progressKey(this.capHash, f.transferId)).catch(() => undefined);
    }
    if (!keepDone) await this.d.store.removeSession(this.d.sessionId).catch(() => undefined);
  }

  private finish(phase: RxPhase): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.update({ phase, eta: null });
    if (this.historyWritten || !this.d.history || this.state_.files.length === 0) return;
    this.historyWritten = true;
    const files = this.state_.files;
    const status: HistoryStatus =
      phase === 'completed'
        ? 'completed'
        : phase === 'partial'
          ? 'partial'
          : phase === 'cancelled'
            ? 'cancelled'
            : 'failed';
    void this.d.history.add({
      id: `rx:${this.d.sessionId}`,
      direction: 'received',
      title: files[0]?.name ?? '',
      fileCount: files.length,
      totalBytes: this.state_.total,
      transferredBytes: sum(files),
      peer: this.senderName,
      status,
      createdAt: Date.now(),
    });
  }

  private log(key: string, params?: Record<string, string | number>): void {
    this.update({ log: [...this.state_.log, { at: Date.now(), key, ...(params ? { params } : {}) }].slice(-50) });
  }
}

function verifiedOf(p: Progress): number {
  const bm = new Bitmap(Math.ceil(p.size / p.blockSize), p.bitmap);
  let n = 0;
  for (let i = 0; i < bm.size; i++) if (bm.has(i)) n += Math.min(p.blockSize, p.size - i * p.blockSize);
  return n;
}

const sum = (files: RxFile[]) => files.reduce((a, f) => a + (f.done ? f.size : f.verified), 0);
