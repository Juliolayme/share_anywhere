import Foundation
import SAStore

public enum RxPhase: String, Sendable, Equatable {
    case loading, choose, connecting, transferring, paused, reconnecting, verifying, completed, partial, failed, cancelled, unreachable

    public var isActive: Bool { self == .connecting || self == .transferring || self == .reconnecting || self == .verifying }
    public var isFinal: Bool { self == .completed || self == .partial || self == .failed || self == .cancelled }
}

public struct RxFile: Sendable, Equatable, Identifiable {
    public var index: Int
    public var fileId: String
    public var transferId: String
    public var name: String
    public var size: Int64
    public var mime: String
    public var verified: Int64
    public var done: Bool
    public var failed: Bool
    /// Where the verified file was saved.
    public var savedURL: URL?
    public var id: String { transferId }
}

public struct RxState: Sendable, Equatable {
    public var phase: RxPhase = .loading
    public var files: [RxFile] = []
    public var total: Int64 = 0
    public var verified: Int64 = 0
    public var route: String?
    public var bytesPerSecond: Double = 0
    public var eta: Int64?
    /// Catalog error key when failed (product.tx_err_*).
    public var error: String?
    public var target: SaveTarget?
    public var words: [String] = []
    public var senderName = ""
    public var duplicates = 0
    public var resumedBytes: Int64 = 0
    /// What the selected candidate pair runs over (docs/ARCHITECTURE.md §6); nil until a channel is classified.
    public var routeKind: RouteKind?
    /// The server stopped issuing TURN credentials: the session's relay byte cap is reached.
    public var relayCapped = false
    public init() {}
}

/// A save folder the app resolved (and, for a picked folder, holds security-scoped access to until `release`).
public final class ScopedFolder: Sendable {
    public let url: URL
    private let onRelease: @Sendable () -> Void

    public init(url: URL, onRelease: @escaping @Sendable () -> Void = {}) {
        self.url = url
        self.onRelease = onRelease
    }

    public func release() { onRelease() }
}

public struct ReceiverDeps: Sendable {
    public var sessionId: String
    public var sessions: any SessionService
    public var transfers: any TransferService
    public var socket: SessionSocket
    public var peers: any PeerFactory
    public var targets: JSONMap<SaveTarget>
    /// Transfer key → path of the verified file, so a reopened receive can still offer Open in Files.
    public var saved: JSONMap<String>
    public var history: HistoryStore?
    /// Resolves a save target to a folder; nil when it can no longer be reached (folder moved, access revoked).
    public var resolveFolder: @Sendable (SaveTarget) -> ScopedFolder?
    public var clock: MillisClock
    public var sleep: Sleeper
    public var random: @Sendable () -> Double
    /// The ICE policy step the first dial uses (`all`; UI tests force a relay step).
    public var routeStep: PolicyStep = .all
    /// The route monitor's thresholds (the shared defaults; tests shorten them).
    public var routeConfig = MonitorConfig()

    public init(
        sessionId: String, sessions: any SessionService, transfers: any TransferService, socket: SessionSocket, peers: any PeerFactory,
        targets: JSONMap<SaveTarget>, saved: JSONMap<String>, history: HistoryStore?,
        resolveFolder: @escaping @Sendable (SaveTarget) -> ScopedFolder?, clock: @escaping MillisClock = systemClock,
        sleep: @escaping Sleeper = systemSleeper, random: @escaping @Sendable () -> Double = { Double.random(in: 0 ..< 1) }
    ) {
        self.sessionId = sessionId
        self.sessions = sessions
        self.transfers = transfers
        self.socket = socket
        self.peers = peers
        self.targets = targets
        self.saved = saved
        self.history = history
        self.resolveFolder = resolveFolder
        self.clock = clock
        self.sleep = sleep
        self.random = random
    }
}

/// Drives one receive (docs/TRANSFER_PROTOCOL.md), the iOS twin of the Web's ReceiverController and Android's
/// `ReceiverController`: the folder the user chose, the peer connection (the receiver offers), the sidecar bitmap for
/// resume, state reports, reconnects within the 2/10-minute windows, and the local History entry.
public actor ReceiverController {
    public nonisolated let state = StateCell(RxState())
    private nonisolated let queue = EventQueue()
    private let d: ReceiverDeps
    private let reporter: Reporter
    private var capability = ""
    private var capHash = ""
    private var senderPid = ""
    private var participantId = ""
    private var link: (any PeerLink)?
    private var linkState: PeerState = .new
    private var channel: (any DataChannelLink)?
    private var conn: ReceiverConnection?
    private var connId = ""
    private var attempt = 0
    private var retryTask: Task<Void, Never>?
    private var openTask: Task<Void, Never>?
    private var samplerTask: Task<Void, Never>?
    private var socketTask: Task<Void, Never>?
    private var loadTask: Task<Void, Never>?
    private var sinks: [Int: PartialFileSink] = [:]
    private var folder: ScopedFolder?
    private var throughput = Throughput()
    private var stopped = false
    private var hadData = false
    private var historyWritten = false
    private var startedAt: Int64?
    private var downSince: Int64?
    private var everOpened = false
    /// Route strategy: which ICE policy step to dial on, and when to move one step stricter (ARCHITECTURE §6).
    private var route = RouteMonitor()
    private var routeTask: Task<Void, Never>?
    /// When the current TURN credential expires (ms), to renew a relayed connection before it lapses.
    private var credExpiresAt: Int64?
    /// Whether the current connection's channel opened; dials on a stricter step that never opened, in a row.
    private var connOpened = false
    private var unopened = 0

    public init(_ deps: ReceiverDeps) {
        d = deps
        route = RouteMonitor(step: deps.routeStep, config: deps.routeConfig)
        reporter = Reporter(sink: TransfersReportSink(api: deps.transfers), now: deps.clock, sleep: deps.sleep)
    }

    private var s: RxState { state.value }
    private func update(_ f: (inout RxState) -> Void) { state.update(f) }
    private func open() -> [RxFile] { s.files.filter { !$0.done && !$0.failed } }

    /// Loads the session, records and saved progress; resumes when a folder is already chosen.
    public func start() {
        if loadTask != nil { return }
        loadTask = Task {
            do { try await self.load() } catch { self.update {
                $0.phase = .failed
                $0.error = "product.error_generic"
            } }
        }
    }

    public func loaded() async { await loadTask?.value }

    private func load() async throws {
        // Out of PAUSED only through the resume action; stay paused when the user (or the sender) paused.
        await reporter.setResume { [weak self] id in await self?.resumeAction(id) }
        let view = try await d.sessions.get(d.sessionId)
        let list = try await d.transfers.list(sessionId: d.sessionId)
        senderPid = view.sender?.participantId ?? ""
        participantId = view.me?.id ?? ""
        capability = list.capability ?? ""
        capHash = sha256Hex(capability)
        let target = await d.targets.get(d.sessionId)
        if let target { folder = d.resolveFolder(target) }
        let byFile = Dictionary(list.transfers.map { ($0.fileId, $0) }, uniquingKeysWith: { a, _ in a })
        var files: [RxFile] = []
        for (index, f) in (view.files ?? []).enumerated() {
            guard let t = byFile[f.id] else { continue }
            await reporter.seed(t.id, t.status, t.verifiedBytes)
            let savedPath = await d.saved.get(key(t.id))
            let side = folder.map { IncomingFolder(directory: $0.url) }?.peek(key(t.id))
            files.append(RxFile(
                index: index, fileId: f.id, transferId: t.id, name: f.name, size: f.size, mime: f.mime,
                verified: side.map(verifiedOf) ?? 0, done: t.status == "COMPLETED" || savedPath != nil,
                failed: t.status == "FAILED" || t.status == "CANCELLED", savedURL: savedPath.map { URL(fileURLWithPath: $0) }
            ))
        }
        update {
            $0.words = view.me?.securityWords ?? []
            $0.senderName = view.sender?.displayName ?? ""
            $0.files = files
            $0.total = files.reduce(0) { $0 + $1.size }
            $0.verified = Self.sum(files)
            $0.resumedBytes = files.filter { !$0.done }.reduce(0) { $0 + $1.verified }
            $0.target = target
        }
        let events = d.socket.events()
        socketTask = Task { [weak self] in
            for await e in events {
                guard let self else { return }
                await self.onSocket(e)
            }
        }
        let statuses = list.transfers.map(\.status)
        if !statuses.isEmpty, statuses.allSatisfy({ $0 == "COMPLETED" }) { return finish(.completed) }
        if !statuses.isEmpty,
           statuses.allSatisfy(Transitions.terminal) { return finish(statuses.contains("COMPLETED") ? .partial : .cancelled) }
        guard target != nil, folder != nil else { return update { $0.phase = .choose } }
        if statuses.contains("PAUSED") { return update { $0.phase = .paused } }
        await connect()
    }

    private func resumeAction(_ id: String) async -> String? {
        if s.phase == .paused { return nil }
        return try? await d.transfers.action(transferId: id, .resume, capability: capability).status
    }

    /// RX-5b: the user chose where to save.
    public func choose(_ target: SaveTarget) async {
        await loadTask?.value
        guard let f = d.resolveFolder(target) else {
            return update {
                $0.phase = .choose
                $0.error = "product.tx_err_storage"
            }
        }
        folder?.release()
        folder = f
        try? await d.targets.put(d.sessionId, target)
        update {
            $0.target = target
            $0.error = nil
        }
        for file in open() where await reporter.current(file.transferId) == "PAUSED" {
            _ = file
            return update { $0.phase = .paused }
        }
        await connect()
    }

    public func pause() async {
        let p = s.phase
        if p.isFinal || p == .paused || p == .unreachable || p == .verifying || p == .choose || p == .loading { return }
        retryTask?.cancel()
        retryTask = nil
        if let c = conn { await c.pause() } else { teardown() }
        update {
            $0.phase = .paused
            $0.eta = nil
        }
        for f in open() {
            if let t = try? await d.transfers.action(transferId: f.transferId, .pause, capability: capability) {
                await reporter.seed(f.transferId, t.status, t.verifiedBytes)
            }
        }
    }

    public func resume() async {
        if s.phase != .paused { return }
        for f in open() {
            if let t = try? await d.transfers.action(transferId: f.transferId, .resume, capability: capability) {
                await reporter.seed(f.transferId, t.status, t.verifiedBytes)
            }
        }
        if let c = conn, linkState == .connected {
            await c.resume()
            update { $0.phase = .transferring }
            for f in open() {
                await reporter.state(f.transferId, "TRANSFERRING", bytes: f.verified)
            }
        } else {
            update { $0.phase = .connecting }
            attempt = 0
            downSince = nil
            await connect()
        }
    }

    /// After the reconnect window ran out: a new window.
    public func retry() async {
        if s.phase != .unreachable { return }
        attempt = 0
        downSince = nil
        await connect()
    }

    public func cancel() async {
        await conn?.cancel()
        for f in open() {
            _ = try? await d.transfers.action(transferId: f.transferId, .cancel, capability: capability)
        }
        cleanup(keepDone: true)
        finish(.cancelled)
    }

    /// Removed, blocked, left, or the session ended: stop and keep only finished files.
    public func endedElsewhere() {
        if s.phase.isFinal { return }
        teardown()
        cleanup(keepDone: true)
        let files = s.files
        finish(files.allSatisfy(\.done) ? .completed : files.contains(where: \.done) ? .partial : .cancelled)
    }

    public func dispose() async {
        stopped = true
        teardown()
        await reporter.dispose()
        socketTask?.cancel()
        for sink in sinks.values {
            sink.close()
        }
        sinks.removeAll()
        folder?.release()
        folder = nil
    }

    // MARK: - Connection

    private func connect() async {
        if stopped || s.phase.isFinal || s.phase == .paused { return }
        teardown()
        if downSince == nil { downSince = d.clock() }
        let reconnecting = hadData || attempt > 0
        update { $0.phase = reconnecting ? .reconnecting : .connecting }
        for f in open() {
            await reporter.state(f.transferId, reconnecting ? "RECONNECTING" : "CONNECTING", bytes: f.verified)
        }
        await dial()
    }

    private func dial() async {
        let id = UUID().uuidString.lowercased()
        connId = id
        connOpened = false
        let setup = await rtcSetup(d.transfers, sessionId: d.sessionId, step: route.step)
        if connId != id || stopped { return }
        credExpiresAt = setup.expiresAt
        let capped = setup.turnRefused == "relay_cap_reached"
        if capped != s.relayCapped { update { $0.relayCapped = capped } }
        let sessionId = d.sessionId
        let to = senderPid
        let socket = d.socket
        let callbacks = PeerCallbacks(
            onCandidate: { c in
                if let m = signalMessage(
                    type: "ICE_CANDIDATE",
                    sessionId: sessionId,
                    to: to,
                    payload: CandidatePayload(conn: id, candidate: c)
                ) {
                    socket.send(m)
                }
            },
            onDataChannel: { ch in ch.close() },
            onState: { [self, queue] st in queue.run { await self.onLinkState(id, st) } }
        )
        guard let peer = try? await d.peers.make(iceServers: setup.servers, relayOnly: setup.relayOnly, callbacks: callbacks) else {
            return lost()
        }
        if connId != id || stopped {
            peer.close()
            return
        }
        link = peer
        linkState = .new
        guard let dc = try? peer.createDataChannel(label: transferChannelLabel) else { return lost() }
        channel = dc
        dc.whenOpen { [self, queue] in queue.run { await self.opened(id, dc) } }
        openTask = Task { [weak self, sleep = d.sleep] in
            await sleep(20000)
            if Task.isCancelled { return }
            await self?.openTimedOut(id)
        }
        do {
            let offer = try await peer.offer()
            guard connId == id else { return }
            guard let m = signalMessage(type: "OFFER", sessionId: sessionId, to: to, payload: SDPPayload(conn: id, sdp: offer)),
                  socket.send(m) else { return lost() }
        } catch {
            if connId == id { lost() }
        }
    }

    private func openTimedOut(_ id: String) {
        if connId == id, conn == nil { lost() }
    }

    private func onLinkState(_ id: String, _ st: PeerState) async {
        guard connId == id else { return }
        linkState = st
        switch st {
        case .failed, .closed:
            lost()
        case .disconnected:
            await d.sleep(4000)
            if connId == id, linkState == .disconnected { lost() }
        default:
            break
        }
    }

    private func opened(_ id: String, _ ch: any DataChannelLink) {
        guard connId == id, conn == nil else { return }
        openTask?.cancel()
        downSince = nil
        everOpened = true
        connOpened = true
        unopened = 0
        let events = ReceiverEventsBridge(controller: self, queue: queue)
        let c = ReceiverConnection(ReceiverOptions(
            channel: ch,
            hello: HelloReceiver(sessionId: d.sessionId, participantId: participantId, capability: capability),
            prepare: { [self] e in try await self.prepare(e) },
            events: events
        ))
        conn = c
        let paused = s.phase == .paused
        Task {
            await c.start()
            if paused { await c.pause() }
        }
        samplerTask = Task { [weak self, sleep = d.sleep] in
            while !Task.isCancelled {
                await sleep(500)
                await self?.sample()
            }
        }
        route.rebase(verified: s.verified, now: d.clock())
        update { $0.routeKind = nil }
        if let peer = link {
            // The tick runs on the event queue, not in this task: a migration tears this task down (cancels it), and
            // the new dial must not inherit that cancellation.
            routeTask = Task { [weak self, queue, sleep = d.sleep] in
                while !Task.isCancelled {
                    let c = await peer.classify()
                    if Task.isCancelled { return }
                    guard let self else { return }
                    queue.run { await self.routeTick(id, c) }
                    await sleep(2000)
                }
            }
        }
    }

    /// Every 2 s on an open channel: the classified pair (badge and report) feeds the route monitor; a sustained stall
    /// migrates one policy step stricter, and a relayed connection is renewed before its TURN credential expires (a new
    /// connection on the same step fetches a fresh one).
    /// The policy step the next dial uses.
    public var routeStep: PolicyStep { route.step }

    private func routeTick(_ id: String, _ c: Classified) async {
        guard connId == id, conn != nil, !stopped, !s.phase.isFinal else { return }
        let now = d.clock()
        if let kind = c.kind, kind != s.routeKind {
            await reporter.setRoute(kind.serverRoute)
            update {
                $0.route = kind.serverRoute
                $0.routeKind = kind
            }
        }
        if s.phase == .paused { return route.rebase(verified: s.verified, now: now) }
        let decision = route.sample(connected: linkState == .connected, verified: s.verified, rttMs: c.rttMs, now: now)
        if decision == .migrate { return await migrate(renew: false) }
        let relayed = c.kind != nil && c.kind != .direct
        if relayed, let exp = credExpiresAt, now > exp - 120_000 { await migrate(renew: true) }
    }

    /// Moves to a new connection: one policy step stricter, or (`renew`) the same step with a fresh credential.
    private func migrate(renew _: Bool) async {
        if stopped || s.phase.isFinal { return }
        for f in open() {
            await reporter.state(f.transferId, "DISCONNECTED", bytes: f.verified)
        }
        await connect()
    }

    private func prepare(_ e: FileMetaEntry) async throws -> PreparedFile {
        // FILE_META must describe exactly the files the server announced.
        guard let f = s.files.first(where: { $0.transferId == e.transferId }), f.fileId == e.fileId, f.size == e.size else {
            throw ProtocolError("FILE_META does not match the session’s files")
        }
        guard let folder else { throw ProtocolError("no folder chosen") }
        let dir = IncomingFolder(directory: folder.url)
        let k = key(f.transferId)
        let side: Sidecar = if let existing = dir.load(k, size: e.size, blockSize: e.blockSize) {
            existing
        } else {
            try dir.create(k, name: f.name, size: e.size, blockSize: e.blockSize, blockCount: e.blockCount, now: d.clock())
        }
        let sink = sinks[f.index] ?? PartialFileSink(url: dir.partialURL(k))
        sinks[f.index] = sink
        let bitmap = try Bitmap(size: e.blockCount, bytes: [UInt8](side.bitmap))
        let clock = d.clock
        let holder = SidecarHolder(side)
        return PreparedFile(sink: sink, bitmap: bitmap, persist: { bm in
            try holder.save(bm, dir: dir, now: clock())
        })
    }

    fileprivate func onFileProgress(_ file: Int, _ bytes: Int64) async {
        guard let f = s.files.first(where: { $0.index == file }) else { return }
        if bytes > f.verified, startedAt == nil { startedAt = d.clock() }
        var files = s.files
        if let i = files.firstIndex(where: { $0.index == file }) { files[i].verified = bytes }
        let phase: RxPhase = s.phase == .paused ? .paused : s.phase == .verifying ? .verifying : .transferring
        let entering = phase == .transferring && s.phase != .transferring
        hadData = hadData || bytes > 0
        attempt = 0
        update {
            $0.files = files
            $0.verified = Self.sum(files)
            $0.phase = phase
        }
        if entering {
            for x in files where !x.done && !x.failed {
                await reporter.state(x.transferId, "TRANSFERRING", bytes: x.verified)
            }
        }
        if !f.done { await reporter.progress(f.transferId, bytes) }
    }

    fileprivate func onVerifying() { if s.phase != .paused { update { $0.phase = .verifying } } }

    fileprivate func fileDone(_ file: Int, _ ok: Bool) async {
        guard let f = s.files.first(where: { $0.index == file }) else { return }
        if !ok {
            update { st in if let i = st.files.firstIndex(where: { $0.index == file }) { st.files[i].failed = true } }
            await reporter.state(f.transferId, "FAILED", bytes: f.verified)
            return
        }
        sinks.removeValue(forKey: f.index)?.close()
        // The verified file must land under its name; when it cannot (the folder went away), it is not delivered.
        guard let folder, let url = try? IncomingFolder(directory: folder.url).finish(key(f.transferId), name: f.name) else {
            update { st in
                if let i = st.files.firstIndex(where: { $0.index == file }) { st.files[i].failed = true }
                st.error = "product.tx_err_storage_app"
            }
            await reporter.state(f.transferId, "FAILED", bytes: f.verified)
            return
        }
        try? await d.saved.put(key(f.transferId), url.path)
        update { st in
            if let i = st.files.firstIndex(where: { $0.index == file }) {
                st.files[i].done = true
                st.files[i].verified = st.files[i].size
                st.files[i].savedURL = url
            }
            st.verified = Self.sum(st.files)
        }
        await reporter.state(f.transferId, "COMPLETED", bytes: f.size)
    }

    fileprivate func allDone() {
        let files = s.files
        finish(files.allSatisfy(\.done) ? .completed : files.contains(where: \.done) ? .partial : .failed)
        teardown()
    }

    fileprivate func onPeerPaused() { update { $0.phase = .paused } }
    fileprivate func onPeerResumed() { update { $0.phase = .transferring } }

    fileprivate func connError(_ code: String, _ fatal: Bool) async {
        if stopped || s.phase.isFinal { return }
        if code == ErrorCode.cancelled {
            cleanup(keepDone: true)
            return finish(.cancelled)
        }
        if fatal {
            for f in open() {
                await reporter.state(f.transferId, "FAILED", bytes: f.verified)
            }
            cleanup(keepDone: true)
            update { $0.error = TransferErrorKeys.key(code) }
            return finish(s.files.contains(where: \.done) ? .partial : .failed)
        }
        lost()
    }

    /// The channel dropped or never opened: DISCONNECTED, then redial with jittered backoff (1 s doubling to 15 s).
    private func lost() {
        if stopped || s.phase.isFinal || retryTask != nil { return }
        let paused = s.phase == .paused
        let wasOpen = connOpened
        connOpened = false
        teardown()
        update {
            $0.route = nil
            $0.routeKind = nil
        }
        let report = open()
        let reporter = reporter
        Task {
            for f in report {
                await reporter.state(f.transferId, paused ? "PAUSED" : "DISCONNECTED", bytes: f.verified)
            }
        }
        if paused { return }
        let window: Int64 = everOpened ? 10 * 60000 : 2 * 60000
        if let since = downSince, d.clock() - since > window {
            return update {
                $0.phase = .unreachable
                $0.eta = nil
            }
        }
        update { $0.phase = .reconnecting }
        // Repeated losses of open channels on one policy step move the next dial one step stricter, at once. A dial that
        // never opened says nothing about the path (the sender may be away), unless it was on a stricter step: two of
        // those in a row mean the relay is not usable from here, so go back to the starting step.
        var escalate = false
        if wasOpen {
            escalate = route.lost(now: d.clock()) == .migrate
        } else if route.step != d.routeStep {
            unopened += 1
            if unopened >= 2 {
                unopened = 0
                route.reset(to: d.routeStep, now: d.clock())
            }
        }
        let wait = escalate ? 0 : redialDelayMs(attempt, random: d.random())
        attempt += 1
        retryTask = Task { [weak self, sleep = d.sleep] in
            await sleep(wait)
            if Task.isCancelled { return }
            await self?.redial()
        }
    }

    private func redial() async {
        retryTask = nil
        await connect()
    }

    private func teardown() {
        openTask?.cancel()
        samplerTask?.cancel()
        routeTask?.cancel()
        openTask = nil
        samplerTask = nil
        routeTask = nil
        if let c = conn {
            conn = nil
            Task { [weak self] in
                let dup = await c.counters.duplicates
                await c.close()
                await self?.addDuplicates(dup)
            }
        }
        let ch = channel
        let peer = link
        channel = nil
        link = nil
        linkState = .closed
        connId = ""
        ch?.close()
        peer?.close()
    }

    private func addDuplicates(_ n: Int) { if n > 0 { update { $0.duplicates += n } } }

    private func onSocket(_ e: SocketEvent) async {
        let conn = e.decode("payload", as: ConnOnly.self)?.conn
        switch e.type {
        case "ANSWER" where e.from == senderPid && conn == connId && link != nil:
            guard let sdp = e.decode("payload", as: SDPPayload.self), let peer = link else { return }
            do { try await peer.setRemote(sdp.sdp) } catch { lost() }
        case "ICE_CANDIDATE" where e.from == senderPid && conn == connId && link != nil:
            guard let c = e.decode("payload", as: CandidatePayload.self)?.candidate?.sanitized() else { return }
            await link?.add(c)
        case "TRANSFER_UPDATED":
            guard let t = e.decode("transfer", as: Transfer.self) else { return }
            await onServerUpdate(t.id, t.status, t.verifiedBytes)
        case "SESSION_CLOSED", "SESSION_EXPIRED":
            if !s.phase.isFinal { endedElsewhere() }
        case "PARTICIPANT_REMOVED", "PARTICIPANT_BLOCKED":
            if e.decode("participant", as: Participant.self)?.id == participantId, !s.phase.isFinal { endedElsewhere() }
        case "ERROR" where e.string("code") == "peer_offline" && link != nil:
            lost()
        default:
            break
        }
    }

    /// The sender paused, resumed or cancelled through the server (works while the channel is down too).
    private func onServerUpdate(_ id: String, _ status: String, _ verified: Int64) async {
        guard s.files.contains(where: { $0.transferId == id }) else { return }
        await reporter.seed(id, status, verified)
        if status == "PAUSED", s.phase.isActive || s.phase == .unreachable {
            retryTask?.cancel()
            retryTask = nil
            update {
                $0.phase = .paused
                $0.eta = nil
            }
        }
        if status == "RESUMING", s.phase == .paused {
            if conn != nil, linkState == .connected {
                update { $0.phase = .transferring }
            } else {
                update { $0.phase = .connecting }
                await connect()
            }
        }
        if status == "CANCELLED", !s.phase.isFinal {
            await conn?.close()
            cleanup(keepDone: true)
            finish(.cancelled)
        }
    }

    private func sample() {
        throughput.sample(s.verified, now: d.clock())
        let (bps, eta) = throughput.estimate(s.verified, total: s.total, reconnecting: s.phase == .reconnecting)
        update {
            $0.bytesPerSecond = bps
            $0.eta = eta
        }
    }

    /// Removes unfinished partial files and their sidecars.
    private func cleanup(keepDone: Bool) {
        let dir = folder.map { IncomingFolder(directory: $0.url) }
        for f in s.files where !(keepDone && f.done) {
            sinks.removeValue(forKey: f.index)?.close()
            dir?.discard(key(f.transferId))
        }
    }

    private func finish(_ phase: RxPhase) {
        retryTask?.cancel()
        retryTask = nil
        update {
            $0.phase = phase
            $0.eta = nil
        }
        if historyWritten || s.files.isEmpty { return }
        historyWritten = true
        guard let history = d.history else { return }
        let files = s.files
        let status: HistoryStatus = switch phase {
        case .completed: .completed
        case .partial: .partial
        case .cancelled: .cancelled
        default: .failed
        }
        let rows = files.map { HistoryFile(name: $0.name, size: $0.size, transferredBytes: $0.done ? $0.size : $0.verified) }
        let route: HistoryRoute? = s.route.map { $0 == "relay" ? .relay : .direct }
        let entry = SAStore.HistoryEntry(
            id: "rx:\(d.sessionId)", direction: .received, title: files[0].name, fileCount: files.count, totalBytes: s.total,
            transferredBytes: Self.sum(files), peer: s.senderName, status: status, createdAt: d.clock(),
            peers: s.senderName.isEmpty ? [] : [s.senderName], files: rows, route: route, startedAt: startedAt
        )
        Task { _ = try? await history.add(entry) }
    }

    private func key(_ transferId: String) -> String { "\(capHash):\(transferId)" }

    private func verifiedOf(_ side: Sidecar) -> Int64 {
        let count = Wire.blockCount(size: side.size, blockSize: side.blockSize)
        guard let bm = try? Bitmap(size: count, bytes: [UInt8](side.bitmap)) else { return 0 }
        var n: Int64 = 0
        for i in 0 ..< bm.size where bm.has(i) {
            n += Int64(Wire.blockLength(size: side.size, index: i, blockSize: side.blockSize))
        }
        return n
    }

    private static func sum(_ files: [RxFile]) -> Int64 { files.reduce(0) { $0 + ($1.done ? $1.size : $1.verified) } }
}

private struct ConnOnly: Decodable { let conn: String? }

/// The latest sidecar of one file; persist calls come one at a time from the engine's work queue.
private final class SidecarHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var side: Sidecar
    init(_ side: Sidecar) { self.side = side }

    func save(_ bm: Bitmap, dir: IncomingFolder, now: Int64) throws {
        let next = lock.locked { () -> Sidecar in
            side.bitmap = Data(bm.bytes)
            side.updatedAt = now
            return side
        }
        try dir.save(next)
    }
}

private struct ReceiverEventsBridge: ReceiverEvents {
    let controller: ReceiverController
    let queue: EventQueue

    private func run(_ job: @escaping @Sendable (ReceiverController) async -> Void) {
        let c = controller
        queue.run { await job(c) }
    }

    func onProgress(file: Int, verifiedBytes: Int64) { run { await $0.onFileProgress(file, verifiedBytes) } }
    func onVerifying(file _: Int, hashedBytes _: Int64) { run { await $0.onVerifying() } }
    func onFileDone(file: Int, ok: Bool) { run { await $0.fileDone(file, ok) } }
    func onComplete() { run { await $0.allDone() } }
    func onPaused(byPeer _: Bool) { run { await $0.onPeerPaused() } }
    func onResumed(byPeer _: Bool) { run { await $0.onPeerResumed() } }
    func onError(code: String, fatal: Bool, message _: String?) {
        // The error code only: messages can carry file paths or a peer's text.
        run { await $0.connError(code, fatal) }
    }
}
