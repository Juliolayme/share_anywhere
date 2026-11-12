import Foundation
import SAStore

/// A file source the controller closes when the session ends (the app's security-scoped sources stop access then).
public protocol ClosableFileSource: FileSource {
    func close()
}

extension FileReadSource: ClosableFileSource {}

public struct SenderDeps: Sendable {
    public var sessionId: String
    public var sessions: any SessionService
    public var transfers: any TransferService
    public var socket: SessionSocket
    public var peers: any PeerFactory
    public var outgoing: JSONMap<[OutgoingFile]>
    public var history: HistoryStore?
    /// Opens a picked file from its locator; nil when access is gone (moved, deleted, bookmark stale).
    public var openSource: @Sendable (OutgoingFile) -> (any ClosableFileSource)?
    public var clock: MillisClock
    public var sleep: Sleeper
    /// The 10-minute window after which a receiver with no channel shows Offline.
    public var reconnectWindowMs: Int64 = 10 * 60000

    public init(
        sessionId: String, sessions: any SessionService, transfers: any TransferService, socket: SessionSocket, peers: any PeerFactory,
        outgoing: JSONMap<[OutgoingFile]>, history: HistoryStore?,
        openSource: @escaping @Sendable (OutgoingFile) -> (any ClosableFileSource)?,
        clock: @escaping MillisClock = systemClock, sleep: @escaping Sleeper = systemSleeper
    ) {
        self.sessionId = sessionId
        self.sessions = sessions
        self.transfers = transfers
        self.socket = socket
        self.peers = peers
        self.outgoing = outgoing
        self.history = history
        self.openSource = openSource
        self.clock = clock
        self.sleep = sleep
    }
}

private final class SenderPeer: @unchecked Sendable {
    let link: any PeerLink
    let connId: String
    var throughput = Throughput()
    var conn: SenderConnection?
    var channel: (any DataChannelLink)?
    var ready = false
    var served = false
    var state: PeerState = .new
    var routeTask: Task<Void, Never>?

    init(link: any PeerLink, connId: String) {
        self.link = link
        self.connId = connId
    }
}

/// Serves every receiver of one session from this device (docs/TRANSFER_PROTOCOL.md), the iOS twin of the Web's
/// SenderController and Android's `SenderController`: answers each JOINED receiver's offer, authorizes HELLO against
/// the capability hash, shares one block cache and whole-file hash across receivers, tracks the 10-minute Offline
/// window, and writes History. All state lives in the actor.
public actor SenderController {
    public nonisolated let state = StateCell(TxState())
    /// Peer and engine callbacks, applied in the order they happened.
    private nonisolated let queue = EventQueue()
    private let d: SenderDeps
    private var peers: [String: SenderPeer] = [:]
    private var gone: Set<String> = []
    private var transfers: [String: Transfer] = [:]
    private var downTimers: [String: Task<Void, Never>] = [:]
    private var resuming: Set<String> = []
    private var pendingIce: [String: [(conn: String, list: [CandidateJSON])]] = [:]
    private var hashes: [Int: FileHash] = [:]
    private let cache = BlockCache()
    private var senderFiles: [SenderFile] = []
    private var sources: [any ClosableFileSource] = []
    private var list: TransferList?
    private var historyKey = ""
    private var startedAt: Int64?
    private var socketTask: Task<Void, Never>?
    private var samplerTask: Task<Void, Never>?
    private var loadTask: Task<Void, Never>?
    private var disposed = false

    public init(_ deps: SenderDeps) { d = deps }

    private var s: TxState { state.value }
    private func update(_ f: (inout TxState) -> Void) { state.update(f) }

    public func start() {
        if loadTask != nil { return }
        loadTask = Task { try? await self.load() }
    }

    /// Waits for the first load (tests and the dashboard's first frame).
    public func loaded() async { await loadTask?.value }

    private func load() async throws {
        let view = try await d.sessions.get(d.sessionId)
        let files = (view.files ?? []).enumerated().map { i, f in TxFile(index: i, fileId: f.id, name: f.name, size: f.size, mime: f.mime) }
        let rows = await d.outgoing.get(d.sessionId) ?? []
        if rows.count == files.count, !files.isEmpty, zip(rows, files).allSatisfy({ $0.fileId == $1.fileId && $0.size == $1.size }) {
            var opened: [SenderFile] = []
            for (f, r) in zip(files, rows) {
                guard let src = d.openSource(r) else { break }
                sources.append(src)
                opened.append(SenderFile(
                    index: f.index,
                    fileId: f.fileId,
                    transferId: "",
                    name: f.name,
                    size: f.size,
                    mime: f.mime,
                    source: src
                ))
            }
            if opened.count == files.count {
                senderFiles = opened
                for f in opened {
                    hashes[f.index] = FileHash(source: f.source)
                }
            }
        }
        let has = senderFiles.count == files.count && !files.isEmpty
        update {
            $0.files = files
            $0.hasFiles = has
        }
        let events = d.socket.events()
        socketTask = Task { [weak self] in
            for await e in events {
                guard let self else { return }
                await self.onSocket(e)
            }
        }
        await refresh(view)
        samplerTask = Task { [weak self, sleep = d.sleep] in
            while !Task.isCancelled {
                await sleep(500)
                await self?.sample()
            }
        }
        update { $0.loaded = true }
    }

    public func refresh(_ given: SessionView? = nil) async {
        var view = given
        if view == nil { view = try? await d.sessions.get(d.sessionId) }
        guard let v = view, let l = try? await d.transfers.list(sessionId: d.sessionId) else { return }
        list = l
        for t in l.transfers {
            transfers[t.id] = t
        }
        let total = s.files.reduce(Int64(0)) { $0 + $1.size }
        let shown: Set = ["JOINED", "REMOVED", "BLOCKED", "LEFT"]
        let receivers: [TxReceiver] = (v.participants ?? [])
            .filter { p in p.role == "receiver" && shown.contains(p.status) }
            .filter { p in
                p.status == "JOINED" || l.transfers
                    .contains { $0.participantId == p.id && ($0.verifiedBytes > 0 || $0.status != "PENDING") }
            }
            .map { p in
                let prev = s.receivers.first { $0.participantId == p.id }
                let mine = l.transfers.filter { $0.participantId == p.id }
                let perFile = s.files.map { f in mine.first { $0.fileId == f.fileId }?.verifiedBytes ?? 0 }
                let server = SessionResult.statusFromServer(mine.map(\.status))
                let removed = p.status != "JOINED"
                let settled: TxStatus? = (server == .completed || server == .failed || server == .cancelled) ? server : nil
                var status: TxStatus = if p.status == "BLOCKED" {
                    .blocked
                } else if p.status == "REMOVED" {
                    .removed
                } else if removed {
                    settled ?? .cancelled
                } else if let prev, settled == nil {
                    prev.status
                } else {
                    server ?? .waiting
                }
                if !removed, let server, !live(p.id), settled == nil {
                    if server == .paused {
                        status = .paused
                    } else if status == .paused || status == .transferring || status == .verifying {
                        status = .reconnecting
                    }
                }
                let merged = prev
                    .map { pr in pr.perFile.enumerated().map { i, n in max(n, i < perFile.count ? perFile[i] : 0) } } ?? perFile
                return TxReceiver(
                    participantId: p.id, name: p.displayName, platform: p.platform, joined: !removed,
                    delivered: !mine.isEmpty && mine.allSatisfy { $0.status == "COMPLETED" }, status: status,
                    perFile: merged, verified: merged.reduce(0, +), total: total,
                    route: prev?.route ?? mine.first { $0.route != nil }?.route,
                    bytesPerSecond: prev?.bytesPerSecond ?? 0, eta: prev?.eta, error: prev?.error,
                    routeKind: prev?.routeKind
                )
            }
        update {
            $0.receivers = receivers
            $0.ended = $0.ended || (v.status != "WAITING" && v.status != "ACTIVE")
        }
        gone = Set((v.participants ?? []).filter { $0.role == "receiver" && $0.status != "JOINED" }.map(\.id))
        for pid in gone {
            drop(pid)
        }
        let joined = Set(receivers.map(\.participantId)).subtracting(gone)
        pendingIce = pendingIce.filter { joined.contains($0.key) }
        for r in receivers {
            syncWindow(r.participantId)
        }
        await checkFinal()
    }

    // MARK: - Actions

    public func pause(_ pid: String) async {
        resuming.remove(pid)
        await peers[pid]?.conn?.pause()
        patch(pid) { $0.status = .paused }
        for t in openTransfers(pid) {
            _ = try? await d.transfers.action(transferId: t.id, .pause, capability: nil)
        }
    }

    public func resume(_ pid: String) async {
        resuming.insert(pid)
        let isLive = live(pid)
        patch(pid) { $0.status = isLive ? .transferring : .reconnecting }
        for t in openTransfers(pid) {
            let done = try? await d.transfers.action(transferId: t.id, .resume, capability: nil)
            if done == nil { resuming.remove(pid) }
        }
        await peers[pid]?.conn?.resume()
    }

    public func cancel(_ pid: String) async {
        await peers[pid]?.conn?.cancel()
        patch(pid) { $0.status = .cancelled }
        for t in openTransfers(pid) {
            _ = try? await d.transfers.action(transferId: t.id, .cancel, capability: nil)
        }
        await checkFinal()
    }

    public func pauseAll() async {
        for r in s.receivers where r.status.isActive {
            await pause(r.participantId)
        }
    }

    /// Stop all (TR-6): cancels every transfer still going.
    public func cancelAll() async {
        for r in s.receivers where !r.status.isEnded {
            await cancel(r.participantId)
        }
    }

    public func dispose() async {
        disposed = true
        socketTask?.cancel()
        samplerTask?.cancel()
        for t in downTimers.values {
            t.cancel()
        }
        downTimers.removeAll()
        pendingIce.removeAll()
        await cache.clear()
        for pid in Array(peers.keys) {
            drop(pid)
        }
        for src in sources {
            src.close()
        }
        sources.removeAll()
    }

    // MARK: - Internals

    private func drop(_ pid: String) {
        guard let p = peers.removeValue(forKey: pid) else { return }
        if let conn = p.conn { Task { await conn.close() } }
        p.routeTask?.cancel()
        p.channel?.close()
        p.link.close()
    }

    private func openTransfers(_ pid: String) -> [Transfer] {
        transfers.values.filter { $0.participantId == pid && !Transitions.terminal($0.status) }
    }

    private func patch(_ pid: String, _ f: (inout TxReceiver) -> Void) {
        let before = s.receivers.first { $0.participantId == pid }?.status
        update { st in
            if let i = st.receivers.firstIndex(where: { $0.participantId == pid }) { f(&st.receivers[i]) }
        }
        if s.receivers.first(where: { $0.participantId == pid })?.status != before { syncWindow(pid) }
    }

    /// Reconnect window: connecting or reconnecting with no open channel for 10 minutes shows Offline.
    private func syncWindow(_ pid: String) {
        let r = s.receivers.first { $0.participantId == pid }
        let down = r.map { ($0.status == .reconnecting || $0.status == .connecting) && !live(pid) } ?? false
        if !down {
            downTimers.removeValue(forKey: pid)?.cancel()
            return
        }
        if downTimers[pid] != nil { return }
        let wait = d.reconnectWindowMs
        downTimers[pid] = Task { [weak self, sleep = d.sleep] in
            await sleep(wait)
            if Task.isCancelled { return }
            await self?.windowEnded(pid)
        }
    }

    private func windowEnded(_ pid: String) {
        downTimers[pid] = nil
        let cur = s.receivers.first { $0.participantId == pid }
        if cur?.status == .reconnecting || cur?.status == .connecting, !live(pid) { patch(pid) { $0.status = .offline } }
    }

    private func onSocket(_ e: SocketEvent) async {
        if disposed { return }
        let from = e.from ?? ""
        switch e.type {
        case "OFFER" where !from.isEmpty:
            guard let sdp = e.decode("payload", as: SDPPayload.self), sdp.conn.count <= 64 else { return }
            await onOffer(from, sdp)
        case "ICE_CANDIDATE" where !from.isEmpty:
            guard let c = e.decode("payload", as: CandidatePayload.self), c.conn.count <= 64,
                  let cand = c.candidate?.sanitized() else { return }
            if let p = peers[from], c.conn == p.connId, p.ready {
                await p.link.add(cand)
            } else {
                hold(from, c.conn, cand)
            }
        case "TRANSFER_UPDATED":
            guard let t = e.decode("transfer", as: Transfer.self) else { return }
            transfers[t.id] = t
            let server = SessionResult.statusFromServer(transfers.values.filter { $0.participantId == t.participantId }.map(\.status))
            let r = s.receivers.first { $0.participantId == t.participantId }
            if let r, let server, server == .completed || server == .failed || server == .cancelled, !r.status.isExcluded {
                patch(r.participantId) { $0.status = server }
            }
            if server != .paused { resuming.remove(t.participantId) }
            if let r, server == .paused, r.status.isActive, !resuming.contains(r.participantId) {
                patch(r.participantId) { $0.status = .paused }
            }
            if let r, r.status == .paused, server == .transferring || server == .connecting || server == .reconnecting {
                let isLive = live(r.participantId)
                patch(r.participantId) { $0.status = isLive ? .transferring : .reconnecting }
            }
            await checkFinal()
        case "SESSION_CLOSED", "SESSION_EXPIRED":
            for pid in Array(peers.keys) {
                drop(pid)
            }
            for r in s.receivers where !r.status.isEnded {
                patch(r.participantId) {
                    $0.status = .cancelled
                    $0.eta = nil
                    $0.bytesPerSecond = 0
                }
            }
            update { $0.ended = true }
            await checkFinal()
        default:
            if e.type.hasPrefix("PARTICIPANT_") || e.type == "SESSION_UPDATED" || e.type == SocketEvent.open { await refresh() }
        }
    }

    private func onOffer(_ pid: String, _ payload: SDPPayload) async {
        if !s.receivers.contains(where: { $0.participantId == pid && !gone.contains(pid) }) { await refresh() }
        guard let r = s.receivers.first(where: { $0.participantId == pid }), !gone.contains(pid) else { return }
        drop(pid)
        let servers = await ICEServer.from(try? d.transfers.turn(sessionId: d.sessionId))
        let conn = payload.conn
        let sessionId = d.sessionId
        let socket = d.socket
        let holder = PeerHolder()
        let callbacks = PeerCallbacks(
            onCandidate: { c in
                if let m = signalMessage(
                    type: "ICE_CANDIDATE",
                    sessionId: sessionId,
                    to: pid,
                    payload: CandidatePayload(conn: conn, candidate: c)
                ) {
                    socket.send(m)
                }
            },
            onDataChannel: { [self, queue] ch in
                queue.run { await self.onDataChannel(pid, holder.id, ch) }
            },
            onState: { [self, queue] st in
                queue.run { await self.onPeerState(pid, holder.id, st) }
            }
        )
        guard let link = try? await d.peers.make(iceServers: servers, callbacks: callbacks) else { return }
        let peer = SenderPeer(link: link, connId: conn)
        holder.id = ObjectIdentifier(peer)
        peers[pid] = peer
        do {
            try await link.setRemote(payload.sdp)
            peer.ready = true
            if let i = pendingIce[pid]?.firstIndex(where: { $0.conn == conn }) {
                let held = pendingIce[pid]!.remove(at: i).list
                for c in held {
                    await link.add(c)
                }
            }
            let answer = try await link.answer()
            guard peers[pid] === peer else { return }
            if let m = signalMessage(type: "ANSWER", sessionId: sessionId, to: pid, payload: SDPPayload(conn: conn, sdp: answer)) {
                socket.send(m)
            }
            if r.status == .waiting { patch(pid) { $0.status = .connecting } }
        } catch {
            if peers[pid] === peer { drop(pid) }
        }
    }

    private func onDataChannel(_ pid: String, _ id: ObjectIdentifier?, _ ch: any DataChannelLink) {
        guard ch.label == transferChannelLabel, let peer = peers[pid], ObjectIdentifier(peer) == id else {
            ch.close()
            return
        }
        peer.channel = ch
        ch.whenOpen { [self, queue] in
            queue.run { await self.serveOnce(pid, id) }
        }
    }

    private func onPeerState(_ pid: String, _ id: ObjectIdentifier?, _ st: PeerState) async {
        guard let peer = peers[pid], ObjectIdentifier(peer) == id else { return }
        peer.state = st
        switch st {
        case .failed, .closed:
            lostPeer(pid)
        case .disconnected:
            await d.sleep(4000)
            if let p = peers[pid], p === peer, p.state == .disconnected { lostPeer(pid) }
        case .connected:
            syncWindow(pid)
        default:
            break
        }
    }

    private func serveOnce(_ pid: String, _ id: ObjectIdentifier?) async {
        guard let peer = peers[pid], ObjectIdentifier(peer) == id, !peer.served, let ch = peer.channel else { return }
        peer.served = true
        let mine = (list?.transfers ?? []).filter { $0.participantId == pid }
        let files = senderFiles.map { f in
            SenderFile(
                index: f.index, fileId: f.fileId, transferId: mine.first { $0.fileId == f.fileId }?.id ?? "", name: f.name,
                size: f.size, mime: f.mime, source: f.source
            )
        }
        let events = SenderEventsBridge(pid: pid, controller: self, queue: queue)
        var options = SenderOptions(
            channel: ch, sessionId: d.sessionId, files: files, hashes: hashes,
            authorize: { [weak self] participant, capability in
                guard let self, participant == pid else { return false }
                return await self.authorize(pid, capability)
            },
            events: events, cache: cache
        )
        options.unavailable = !s.hasFiles
        peer.conn = SenderConnection(options)
        let link = peer.link
        // The receiver's route badge: the selected pair, every 2 s while this connection lives (it can change after an
        // ICE restart or a migration on the receiver's side).
        peer.routeTask = Task { [weak self, queue, sleep = d.sleep] in
            while !Task.isCancelled {
                let c = await link.classify()
                if Task.isCancelled { return }
                if let kind = c.kind, let self { queue.run { await self.setRoute(pid, id, kind) } }
                await sleep(2000)
            }
        }
    }

    private func setRoute(_ pid: String, _ id: ObjectIdentifier?, _ kind: RouteKind) {
        guard let peer = peers[pid], ObjectIdentifier(peer) == id, peer.conn != nil else { return }
        guard s.receivers.first(where: { $0.participantId == pid })?.routeKind != kind else { return }
        patch(pid) {
            $0.route = kind.serverRoute
            $0.routeKind = kind
        }
    }

    private func authorize(_ pid: String, _ capability: String) async -> Bool {
        var p = list?.peers?.first { $0.participantId == pid }
        if p?.capabilityHash == nil {
            await refresh()
            p = list?.peers?.first { $0.participantId == pid }
        }
        guard let p, let hash = p.capabilityHash, p.status == "JOINED" else { return false }
        return sha256Hex(capability) == hash
    }

    fileprivate func onAuthorized(_ pid: String) async {
        downTimers.removeValue(forKey: pid)?.cancel()
        let paused = SessionResult.statusFromServer(transfers.values.filter { $0.participantId == pid }.map(\.status)) == .paused
        if paused { await peers[pid]?.conn?.pause() }
        patch(pid) {
            $0.status = paused ? .paused : .transferring
            $0.error = nil
        }
    }

    fileprivate func onProgress(_ pid: String, file: Int, bytes: Int64) {
        if bytes > 0, startedAt == nil { startedAt = d.clock() }
        patch(pid) { cur in
            if file < cur.perFile.count { cur.perFile[file] = max(cur.perFile[file], bytes) }
            cur.verified = cur.perFile.reduce(0, +)
            if cur.status == .reconnecting || cur.status == .connecting { cur.status = .transferring }
        }
    }

    fileprivate func onComplete(_ pid: String) async {
        patch(pid) { $0.status = .completed }
        await checkFinal()
    }

    fileprivate func onPaused(_ pid: String) { patch(pid) { $0.status = .paused } }

    fileprivate func onResumed(_ pid: String) { patch(pid) { $0.status = .transferring } }

    fileprivate func connError(_ pid: String, code: String, fatal: Bool) {
        guard let r = s.receivers.first(where: { $0.participantId == pid }), !r.status.isEnded else { return }
        if code == ErrorCode.cancelled { return patch(pid) { $0.status = .cancelled } }
        if fatal {
            let key = code == ErrorCode.checksumRetries || code == ErrorCode.fileHashMismatch || code == ErrorCode.unauthorized ||
                code == ErrorCode.fileUnreadable ? TransferErrorKeys.key(code) : "product.tx_err_protocol"
            return patch(pid) {
                $0.status = .failed
                $0.error = key
            }
        }
        lostPeer(pid)
    }

    private func hold(_ pid: String, _ conn: String, _ c: CandidateJSON) {
        var byConn = pendingIce[pid] ?? []
        if let i = byConn.firstIndex(where: { $0.conn == conn }) {
            if byConn[i].list.count < 50 { byConn[i].list.append(c) }
        } else {
            byConn.append((conn, [c]))
        }
        while byConn.count > 2 {
            byConn.removeFirst()
        }
        pendingIce[pid] = byConn
    }

    private func lostPeer(_ pid: String) {
        if let p = peers[pid], let conn = p.conn {
            p.conn = nil
            Task { await conn.close() }
        }
        peers[pid]?.routeTask?.cancel()
        let r = s.receivers.first { $0.participantId == pid }
        if r?.route != nil || r?.routeKind != nil {
            patch(pid) {
                $0.route = nil
                $0.routeKind = nil
            }
        }
        guard let r, r.status.isActive else { return }
        patch(pid) {
            $0.status = .reconnecting
            $0.eta = nil
        }
    }

    private func live(_ pid: String) -> Bool {
        guard let p = peers[pid] else { return false }
        return p.conn != nil && p.link.state == .connected
    }

    private func sample() {
        let now = d.clock()
        for (pid, p) in peers {
            guard let r = s.receivers.first(where: { $0.participantId == pid }) else { continue }
            p.throughput.sample(r.verified, now: now)
            let (bps, eta) = p.throughput.estimate(r.verified, total: r.total, reconnecting: r.status == .reconnecting)
            if bps != r.bytesPerSecond || eta != r.eta {
                patch(pid) {
                    $0.bytesPerSecond = bps
                    $0.eta = eta
                }
            }
        }
    }

    private func checkFinal() async {
        let rs = s.receivers
        let all = Array(transfers.values)
        let inputs = rs.map { r in
            let mine = all.filter { $0.participantId == r.participantId }
            return ResultInput(
                status: r.status, delivered: r.delivered, done: mine.count(where: { $0.status == "COMPLETED" }),
                total: max(mine.count, s.files.count)
            )
        }
        let final = SessionResult.of(inputs, ended: s.ended)
        if s.final != final { update { $0.final = final } }
        guard let final, s.hasFiles, let history = d.history else { return }
        let key = "\(final.rawValue)|" + rs.map { "\($0.participantId):\($0.status.rawValue):\($0.verified)" }.joined(separator: ",")
        if key == historyKey { return }
        historyKey = key
        let files = s.files
        let id = "tx:\(d.sessionId)"
        let prev = try? await history.get(id)
        let routes = Array(Set(rs.compactMap(\.route)))
        let route: HistoryRoute? = if routes.count > 1 {
            .mixed
        } else if routes.first == "relay" {
            .relay
        } else if routes.first == "direct" {
            .direct
        } else {
            prev?.route
        }
        let status: HistoryStatus = switch final {
        case .completed: .completed
        case .partial: .partial
        case .failed: .failed
        case .cancelled: .cancelled
        }
        let fileRows: [HistoryFile] = files.enumerated().map { i, f in
            let best = rs.map { f.index < $0.perFile.count ? $0.perFile[f.index] : 0 }.max() ?? 0
            let before: Int64 = (prev?.files).flatMap { i < $0.count ? $0[i].transferredBytes : nil } ?? 0
            return HistoryFile(name: f.name, size: f.size, transferredBytes: max(best, before))
        }
        let totalBytes: Int64 = files.reduce(0) { $0 + $1.size }
        let moved: Int64 = max(rs.map(\.verified).max() ?? 0, prev?.transferredBytes ?? 0)
        let names: [String] = rs.map(\.name)
        let entry = SAStore.HistoryEntry(
            id: id, direction: .sent, title: files.first?.name ?? "", fileCount: files.count, totalBytes: totalBytes,
            transferredBytes: moved, peer: names.joined(separator: ", "), status: status, createdAt: prev?.createdAt ?? d.clock(),
            peers: names, files: fileRows, route: route, startedAt: startedAt ?? prev?.startedAt
        )
        _ = try? await history.add(entry)
    }
}

/// Identifies the peer a callback belongs to (set once the link exists).
private final class PeerHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var value: ObjectIdentifier?
    var id: ObjectIdentifier? {
        get { lock.locked { value } }
        set { lock.locked { value = newValue } }
    }
}

private struct SenderEventsBridge: SenderEvents {
    let pid: String
    let controller: SenderController
    let queue: EventQueue

    private func run(_ job: @escaping @Sendable (SenderController) async -> Void) {
        let c = controller
        queue.run { await job(c) }
    }

    func onAuthorized(participantId _: String) { run { [pid] in await $0.onAuthorized(pid) } }
    func onProgress(file: Int, verifiedBytes: Int64) { run { [pid] in await $0.onProgress(pid, file: file, bytes: verifiedBytes) } }
    func onComplete() { run { [pid] in await $0.onComplete(pid) } }
    func onPaused(byPeer _: Bool) { run { [pid] in await $0.onPaused(pid) } }
    func onResumed(byPeer _: Bool) { run { [pid] in await $0.onResumed(pid) } }
    func onError(code: String, fatal: Bool, message _: String?) {
        // The error code only: messages can carry file paths or a peer's text.
        run { [pid] in await $0.connError(pid, code: code, fatal: fatal) }
    }
}
