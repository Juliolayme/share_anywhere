import type { SessionSocket, SocketEvent } from '../../../lib/ws/socket';
import type { HistoryStatus, HistoryStore } from '../../history/store/history-store';
import type { SessionView } from '../../sharing/api';
import { fromDataChannel } from '../engine/channel';
import { Throughput } from '../engine/eta';
import type { ErrorCode } from '../engine/frame';
import { sha256Hex } from '../engine/hash';
import { FileHash, SenderConnection, fileSource, type SenderFile } from '../engine/sender';
import type { Route, Transfer, TransferList, TransferStatus, TransfersApi } from './api';
import { Observable } from './observable';
import { CHANNEL_LABEL, rtcConfig, selectedRoute, watchPeer, type CandidatePayload, type SdpPayload } from './rtc';
import { terminal } from './transitions';
import type { LogLine } from './receiver-controller';

export type TxStatus =
  | 'waiting'
  /** Dropped and not back within the reconnect window; a new connection from the receiver resumes. */
  | 'offline'
  | 'connecting'
  | 'transferring'
  | 'paused'
  | 'reconnecting'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'removed';

export interface TxReceiver {
  participantId: string;
  name: string;
  platform: string;
  status: TxStatus;
  /** Verified bytes per file index. */
  perFile: number[];
  verified: number;
  total: number;
  route: Route | null;
  bytesPerSecond: number;
  eta: number | null;
  error: string | null;
  log: LogLine[];
}

export interface TxFile {
  index: number;
  fileId: string;
  name: string;
  size: number;
  mime: string;
}

export type TxFinal = 'completed' | 'partial' | 'failed' | 'cancelled' | null;

export interface TxState {
  loaded: boolean;
  files: TxFile[];
  receivers: TxReceiver[];
  /** False after a reload: the browser no longer gives this tab the picked files. */
  hasFiles: boolean;
  final: TxFinal;
  /** End of the open join window (server time, ISO), or null when no window is open. */
  windowEndsAt: string | null;
  /** Milliseconds to add to Date.now() to follow the server clock. */
  serverOffset: number;
}

export interface SenderDeps {
  sessionId: string;
  api: TransfersApi;
  view: () => Promise<SessionView>;
  socket: SessionSocket;
  history: HistoryStore | null;
  files: File[] | undefined;
  createPeer?: (cfg: RTCConfiguration) => RTCPeerConnection;
}

interface Peer {
  pc: RTCPeerConnection;
  conn: SenderConnection | null;
  connId: string;
  throughput: Throughput;
}

const RECONNECT_WINDOW_MS = 10 * 60_000;

const ACTIVE: TxStatus[] = ['connecting', 'transferring', 'reconnecting', 'verifying'];
export const txActive = (s: TxStatus) => ACTIVE.includes(s);

function statusFromServer(ts: TransferStatus[]): TxStatus | null {
  if (!ts.length) return null;
  if (ts.every((s) => s === 'COMPLETED')) return 'completed';
  if (ts.every(terminal))
    return ts.some((s) => s === 'CANCELLED') && !ts.some((s) => s === 'FAILED') ? 'cancelled' : 'failed';
  if (ts.some((s) => s === 'PAUSED')) return 'paused';
  if (ts.some((s) => s === 'DISCONNECTED' || s === 'RECONNECTING')) return 'reconnecting';
  if (ts.some((s) => s === 'TRANSFERRING' || s === 'RESUMING')) return 'transferring';
  if (ts.some((s) => s === 'CONNECTING')) return 'connecting';
  return 'waiting';
}

/** Serves every receiver of one session from this tab (docs/TRANSFER_PROTOCOL.md). */
export class SenderController extends Observable<TxState> {
  private peers = new Map<string, Peer>();
  private transfers = new Map<string, Transfer>();
  private downTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private resuming = new Set<string>();
  private hashes = new Map<number, FileHash>();
  private senderFiles: SenderFile[] = [];
  private list: TransferList | null = null;
  private unsub: (() => void) | null = null;
  private sampler: ReturnType<typeof setInterval> | null = null;
  private historyWritten = false;
  private initialized: Promise<void> | null = null;
  private refusing = 0;
  /** Test hook: corrupt the next N blocks after hashing (VITE_TEST_HOOKS builds only). */
  readonly corrupt = { blocks: 0 };
  /** Test hook: delay before each block in ms (VITE_TEST_HOOKS builds only). */
  readonly pace = { ms: 0 };
  /** ICE and connection diagnostics (memory only). */
  readonly diag: string[] = [];

  constructor(private readonly d: SenderDeps) {
    super({
      loaded: false,
      files: [],
      receivers: [],
      hasFiles: !!d.files,
      final: null,
      windowEndsAt: null,
      serverOffset: 0,
    });
  }

  init(): Promise<void> {
    this.initialized ??= this.load();
    return this.initialized;
  }

  private async load(): Promise<void> {
    const view = await this.d.view();
    const files = (view.files ?? []).map((f, index) => ({
      index,
      fileId: f.id,
      name: f.name,
      size: f.size,
      mime: f.mime,
    }));
    const picked = this.d.files;
    if (picked && picked.length === files.length) {
      this.senderFiles = files.map((f, i) => ({ ...f, transferId: '', source: fileSource(picked[i] as File) }));
      for (const f of this.senderFiles) this.hashes.set(f.index, new FileHash(f.source));
    }
    this.update({ files, hasFiles: this.senderFiles.length === files.length && files.length > 0 });
    this.unsub = this.d.socket.subscribe((e) => this.onSocket(e));
    await this.refresh(view);
    this.sampler = setInterval(() => this.sample(), 500);
    this.update({ loaded: true });
  }

  /** Reloads participants and transfer records (after joins, removals, or an unknown HELLO). */
  async refresh(view?: SessionView): Promise<void> {
    const [v, list] = await Promise.all([view ?? this.d.view(), this.d.api.list(this.d.sessionId)]);
    this.list = list;
    for (const t of list.transfers) this.transfers.set(t.id, t);
    const total = this.state_.files.reduce((a, f) => a + f.size, 0);
    const receivers = (v.participants ?? [])
      .filter(
        (p) =>
          p.role === 'receiver' &&
          (p.status === 'JOINED' || p.status === 'REMOVED' || p.status === 'BLOCKED' || p.status === 'LEFT'),
      )
      .filter(
        (p) => p.status === 'JOINED' || list.transfers.some((t) => t.participant_id === p.id && t.verified_bytes > 0),
      )
      .map((p): TxReceiver => {
        const prev = this.state_.receivers.find((r) => r.participantId === p.id);
        const mine = list.transfers.filter((t) => t.participant_id === p.id);
        const perFile = this.state_.files.map((f) => mine.find((t) => t.file_id === f.fileId)?.verified_bytes ?? 0);
        const server = statusFromServer(mine.map((t) => t.status));
        const removed = p.status !== 'JOINED';
        const status: TxStatus = removed
          ? 'removed'
          : prev && !server?.match(/completed|failed|cancelled/)
            ? prev.status
            : (server ?? 'waiting');
        return {
          participantId: p.id,
          name: p.display_name,
          platform: p.platform,
          status,
          perFile: prev ? prev.perFile.map((n, i) => Math.max(n, perFile[i] ?? 0)) : perFile,
          verified: 0,
          total,
          route: prev?.route ?? (mine.find((t) => t.route)?.route as Route | undefined) ?? null,
          bytesPerSecond: prev?.bytesPerSecond ?? 0,
          eta: prev?.eta ?? null,
          error: prev?.error ?? null,
          log: prev?.log ?? [],
        };
      })
      .map((r) => ({ ...r, verified: r.perFile.reduce((a, b) => a + b, 0) }));
    this.update({
      receivers,
      windowEndsAt: v.join_window?.state === 'OPEN' ? v.join_window.ends_at : null,
      serverOffset: Date.parse(v.server_time) - Date.now(),
    });
    for (const r of receivers) if (r.status === 'removed') this.drop(r.participantId);
    for (const r of receivers) this.syncWindow(r.participantId);
    this.checkFinal();
  }

  pause(pid: string): void {
    const p = this.peers.get(pid);
    this.resuming.delete(pid);
    p?.conn?.pause();
    this.patch(pid, { status: 'paused' });
    for (const t of this.openTransfers(pid)) void this.d.api.action(t.id, 'pause').catch(() => undefined);
  }

  resume(pid: string): void {
    const p = this.peers.get(pid);
    this.resuming.add(pid); // until the server stops saying PAUSED for this receiver
    this.patch(pid, { status: p?.conn ? 'transferring' : 'reconnecting' });
    for (const t of this.openTransfers(pid)) void this.d.api.action(t.id, 'resume').catch(() => undefined);
    p?.conn?.resume();
  }

  cancel(pid: string): void {
    this.peers.get(pid)?.conn?.cancel();
    this.patch(pid, { status: 'cancelled' });
    for (const t of this.openTransfers(pid)) void this.d.api.action(t.id, 'cancel').catch(() => undefined);
    this.checkFinal();
  }

  cancelAll(): void {
    for (const r of this.state_.receivers)
      if (!['completed', 'failed', 'cancelled', 'removed'].includes(r.status)) this.cancel(r.participantId);
  }

  /** Test hook: drop every peer connection and ignore offers for `ms` (simulates the sender going offline). */
  dropFor(ms: number): void {
    this.refusing = Date.now() + ms;
    for (const pid of [...this.peers.keys()]) this.drop(pid);
  }

  get counters() {
    let blocksSent = 0;
    let verifiedResent = 0;
    for (const p of this.peers.values()) {
      blocksSent += p.conn?.counters.blocksSent ?? 0;
      verifiedResent += p.conn?.counters.verifiedResent ?? 0;
    }
    return { blocksSent, verifiedResent };
  }

  dispose(): void {
    this.unsub?.();
    for (const t of this.downTimers.values()) clearTimeout(t);
    this.downTimers.clear();
    if (this.sampler) clearInterval(this.sampler);
    for (const pid of [...this.peers.keys()]) this.drop(pid);
  }

  private drop(pid: string): void {
    const p = this.peers.get(pid);
    if (!p) return;
    this.peers.delete(pid);
    p.conn?.close();
    p.pc.close();
  }

  private openTransfers(pid: string): Transfer[] {
    return [...this.transfers.values()].filter((t) => t.participant_id === pid && !terminal(t.status));
  }

  private patch(pid: string, patch: Partial<TxReceiver>): void {
    this.update((s) => ({
      ...s,
      receivers: s.receivers.map((r) => (r.participantId === pid ? { ...r, ...patch } : r)),
    }));
    if (patch.status) this.syncWindow(pid);
  }

  /**
   * Reconnect window, like the receiver's: a receiver that is connecting or reconnecting with no open channel
   * has 10 minutes to come back; after that it shows Offline and stops holding the screen on. A new connection
   * from it picks the transfer up again.
   */
  private syncWindow(pid: string): void {
    const r = this.state_.receivers.find((x) => x.participantId === pid);
    const down = !!r && (r.status === 'reconnecting' || r.status === 'connecting') && !this.peers.get(pid)?.conn;
    if (!down) return this.clearDownTimer(pid);
    if (this.downTimers.has(pid)) return;
    this.downTimers.set(
      pid,
      setTimeout(() => {
        this.downTimers.delete(pid);
        const cur = this.state_.receivers.find((x) => x.participantId === pid);
        if ((cur?.status === 'reconnecting' || cur?.status === 'connecting') && !this.peers.get(pid)?.conn)
          this.patch(pid, { status: 'offline' });
      }, RECONNECT_WINDOW_MS),
    );
  }

  private log(pid: string, key: string, params?: Record<string, string | number>): void {
    this.update((s) => ({
      ...s,
      receivers: s.receivers.map((r) =>
        r.participantId === pid
          ? { ...r, log: [...r.log, { at: Date.now(), key, ...(params ? { params } : {}) }].slice(-50) }
          : r,
      ),
    }));
  }

  private onSocket(e: SocketEvent): void {
    const from = typeof e.from === 'string' ? e.from : '';
    if (e.type === 'OFFER' && from) void this.onOffer(from, e.payload as SdpPayload);
    else if (e.type === 'ICE_CANDIDATE' && from) {
      const p = this.peers.get(from);
      const c = e.payload as CandidatePayload;
      if (p && c.conn === p.connId && c.candidate) {
        this.diag.push(`remote ${(c.candidate.candidate ?? '').split(' ').slice(4, 8).join(' ')}`);
        void p.pc.addIceCandidate(c.candidate).catch((err: unknown) => this.diag.push(`add-error ${String(err)}`));
      }
    } else if (e.type === 'TRANSFER_UPDATED') {
      const t = e.transfer as Transfer | undefined;
      if (!t) return;
      this.transfers.set(t.id, t);
      const mine = [...this.transfers.values()].filter((x) => x.participant_id === t.participant_id);
      const server = statusFromServer(mine.map((x) => x.status));
      const r = this.state_.receivers.find((x) => x.participantId === t.participant_id);
      if (r && server && ['completed', 'failed', 'cancelled'].includes(server) && r.status !== 'removed')
        this.patch(r.participantId, { status: server });
      if (server !== 'paused') this.resuming.delete(t.participant_id);
      // While a resume of several files is in flight, the files still PAUSED must not flip the card back.
      if (r && server === 'paused' && txActive(r.status) && !this.resuming.has(r.participantId))
        this.patch(r.participantId, { status: 'paused' });
      // Resumed through the server (by the receiver, possibly over a new connection): leave Paused here too.
      if (
        r &&
        r.status === 'paused' &&
        (server === 'transferring' || server === 'connecting' || server === 'reconnecting')
      )
        this.patch(r.participantId, {
          status: this.peers.get(r.participantId)?.conn ? 'transferring' : 'reconnecting',
        });
      this.checkFinal();
    } else if (e.type.startsWith('PARTICIPANT_') || e.type === 'SESSION_UPDATED' || e.type === 'SOCKET_OPEN') {
      // SOCKET_OPEN: events may have been missed while the socket was down; reload the records.
      void this.refresh();
    } else if (e.type === 'SESSION_CLOSED' || e.type === 'SESSION_EXPIRED') {
      for (const pid of [...this.peers.keys()]) this.drop(pid);
      this.checkFinal(true);
    }
  }

  private async onOffer(pid: string, payload: SdpPayload): Promise<void> {
    if (Date.now() < this.refusing) return;
    if (!this.state_.receivers.some((r) => r.participantId === pid && r.status !== 'removed')) await this.refresh();
    const r = this.state_.receivers.find((x) => x.participantId === pid);
    if (!r || r.status === 'removed') return;
    this.drop(pid);
    const cfg = await rtcConfig(this.d.api, this.d.sessionId);
    const pc = this.d.createPeer ? this.d.createPeer(cfg) : new RTCPeerConnection(cfg);
    watchPeer(pc, this.diag);
    this.diag.push(`offer from ${pid.slice(0, 8)} conn ${payload.conn.slice(0, 8)}`);
    const peer: Peer = { pc, conn: null, connId: payload.conn, throughput: new Throughput() };
    this.peers.set(pid, peer);
    pc.onicecandidate = (e) => {
      const c: CandidatePayload = { conn: payload.conn, candidate: e.candidate ? e.candidate.toJSON() : null };
      this.d.socket.send({ type: 'ICE_CANDIDATE', session_id: this.d.sessionId, to: pid, payload: c });
    };
    pc.ondatachannel = (ev) => {
      if (ev.channel.label !== CHANNEL_LABEL || this.peers.get(pid) !== peer) return;
      const dc = ev.channel;
      const go = () => this.serve(pid, peer, dc);
      if (dc.readyState === 'open') go();
      else dc.onopen = go;
    };
    let grace: ReturnType<typeof setTimeout> | null = null;
    pc.onconnectionstatechange = () => {
      if (this.peers.get(pid) !== peer) return;
      if (grace) clearTimeout(grace);
      grace = null;
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.onLost(pid);
      else if (pc.connectionState === 'disconnected')
        grace = setTimeout(() => this.peers.get(pid) === peer && this.onLost(pid), 4000);
    };
    await pc.setRemoteDescription(payload.sdp);
    await pc.setLocalDescription(await pc.createAnswer());
    const answer: SdpPayload = { conn: payload.conn, sdp: pc.localDescription?.toJSON() ?? { type: 'answer' } };
    this.d.socket.send({ type: 'ANSWER', session_id: this.d.sessionId, to: pid, payload: answer });
    if (r.status === 'waiting') this.patch(pid, { status: 'connecting' });
  }

  private serve(pid: string, peer: Peer, dc: RTCDataChannel): void {
    const transfersOf = () => this.list?.transfers.filter((t) => t.participant_id === pid) ?? [];
    const files = this.senderFiles.map((f) => ({
      ...f,
      transferId: transfersOf().find((t) => t.file_id === f.fileId)?.id ?? '',
    }));
    const conn = new SenderConnection({
      channel: fromDataChannel(dc, peer.pc),
      sessionId: this.d.sessionId,
      files,
      hashes: this.hashes,
      unavailable: !this.state_.hasFiles,
      corrupt: this.corrupt,
      pace: this.pace,
      authorize: async (participant, capability) => {
        if (participant !== pid) return false;
        let p = this.list?.peers?.find((x) => x.participant_id === pid);
        if (!p?.capability_hash) {
          await this.refresh();
          p = this.list?.peers?.find((x) => x.participant_id === pid);
        }
        if (!p?.capability_hash || p.status !== 'JOINED') return false;
        const ok = (await sha256Hex(capability)) === p.capability_hash;
        // Fill transfer IDs now that the list is current.
        for (const f of files) f.transferId = transfersOf().find((t) => t.file_id === f.fileId)?.id ?? f.transferId;
        return ok;
      },
      events: {
        onAuthorized: () => {
          const cur = this.state_.receivers.find((r) => r.participantId === pid);
          this.clearDownTimer(pid);
          // The server record says whether this receiver is paused (by either side); a new connection starts
          // paused when it is, so a pause survives a reconnect.
          const paused = this.serverStatus(pid) === 'paused';
          if (paused) conn.pause();
          this.patch(pid, { status: paused ? 'paused' : 'transferring', error: null });
          this.log(pid, 'product.log_sending_to', { name: cur?.name ?? '' });
        },
        onProgress: (file, bytes) => {
          const cur = this.state_.receivers.find((r) => r.participantId === pid);
          if (!cur) return;
          const perFile = cur.perFile.map((n, i) => (i === file ? Math.max(n, bytes) : n));
          const verified = perFile.reduce((a, b) => a + b, 0);
          this.patch(pid, {
            perFile,
            verified,
            ...(cur.status === 'reconnecting' || cur.status === 'connecting'
              ? { status: 'transferring' as const }
              : {}),
          });
        },
        onFileDone: () => undefined,
        onComplete: () => {
          // The receiver confirmed every file hash: done here even before its COMPLETED report arrives.
          this.patch(pid, { status: 'completed' });
          this.checkFinal();
        },
        onPaused: () => this.patch(pid, { status: 'paused' }),
        onResumed: () => this.patch(pid, { status: 'transferring' }),
        onError: (code, fatal) => this.onConnError(pid, code, fatal),
      },
    });
    peer.conn = conn;
    peer.throughput.rebase(
      this.state_.receivers.find((r) => r.participantId === pid)?.verified ?? 0,
      performance.now(),
    );
    void selectedRoute(peer.pc).then((route) => {
      if (!route) return;
      this.patch(pid, { route });
      this.log(pid, route === 'relay' ? 'product.log_relay_plain' : 'product.log_direct');
    });
  }

  private onConnError(pid: string, code: ErrorCode | 'closed', fatal: boolean): void {
    const r = this.state_.receivers.find((x) => x.participantId === pid);
    if (!r || ['completed', 'failed', 'cancelled', 'removed'].includes(r.status)) return;
    if (code === 'cancelled') return this.patch(pid, { status: 'cancelled' });
    if (fatal)
      return this.patch(pid, {
        status: 'failed',
        error: `product.tx_err_${code === 'checksum_retries' || code === 'file_hash_mismatch' ? 'checksum' : code === 'unauthorized' ? 'unauthorized' : code === 'file_unreadable' ? 'sender_files' : 'protocol'}`,
      });
    this.onLost(pid);
  }

  private onLost(pid: string): void {
    const r = this.state_.receivers.find((x) => x.participantId === pid);
    if (!r || !txActive(r.status)) return;
    this.log(pid, 'product.log_connection_lost_plain');
    const p = this.peers.get(pid);
    if (p) p.conn = null; // the channel is gone; the window starts now
    this.patch(pid, { status: 'reconnecting', eta: null });
  }

  private clearDownTimer(pid: string): void {
    const t = this.downTimers.get(pid);
    if (t) clearTimeout(t);
    this.downTimers.delete(pid);
  }

  private serverStatus(pid: string): TxStatus | null {
    return statusFromServer([...this.transfers.values()].filter((t) => t.participant_id === pid).map((t) => t.status));
  }

  private sample(): void {
    const now = performance.now();
    for (const [pid, p] of this.peers) {
      const r = this.state_.receivers.find((x) => x.participantId === pid);
      if (!r) continue;
      p.throughput.sample(r.verified, now);
      const e = p.throughput.estimate(r.verified, r.total, r.status === 'reconnecting');
      if (e.bytesPerSecond !== r.bytesPerSecond || e.seconds !== r.eta)
        this.patch(pid, { bytesPerSecond: e.bytesPerSecond, eta: e.seconds });
    }
  }

  /** Final outcome once every receiver is done (or the session ended); writes one History entry. */
  private checkFinal(sessionEnded = false): void {
    const rs = this.state_.receivers;
    if (!rs.length) return;
    const done = (s: TxStatus) => ['completed', 'failed', 'cancelled', 'removed'].includes(s);
    if (!sessionEnded && !rs.every((r) => done(r.status))) return;
    const completed = rs.filter((r) => r.status === 'completed').length;
    const final: TxFinal =
      completed === rs.length
        ? 'completed'
        : completed > 0
          ? 'partial'
          : rs.some((r) => r.status === 'failed')
            ? 'failed'
            : 'cancelled';
    if (this.state_.final !== final) this.update({ final });
    if (this.historyWritten || !this.d.history) return;
    this.historyWritten = true;
    const files = this.state_.files;
    const status: HistoryStatus = final;
    void this.d.history.add({
      id: `tx:${this.d.sessionId}`,
      direction: 'sent',
      title: files[0]?.name ?? '',
      fileCount: files.length,
      totalBytes: files.reduce((a, f) => a + f.size, 0),
      transferredBytes: Math.max(0, ...rs.map((r) => r.verified)),
      peer: rs.map((r) => r.name).join(', '),
      status,
      createdAt: Date.now(),
    });
  }
}
