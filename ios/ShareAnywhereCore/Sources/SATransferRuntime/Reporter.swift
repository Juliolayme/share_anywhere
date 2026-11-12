import Foundation

/// What the reporter needs from the server: `POST /v1/transfers/{id}/report`. Returns the server's new status.
public protocol ReportSink: Sendable {
    func report(transferId: String, status: String, verifiedBytes: Int64, route: String?) async throws -> String
}

struct TransfersReportSink: ReportSink {
    let api: any TransferService
    func report(transferId: String, status: String, verifiedBytes: Int64, route: String?) async throws -> String {
        try await api.report(transferId: transferId, status: status, verifiedBytes: verifiedBytes, route: route).status
    }
}

/// Reports one receiver's transfer states (docs/TRANSFER_PROTOCOL.md §7), as the Web's Reporter and Android's
/// `Reporter`: state changes at once through allowed intermediate states, progress at most every `intervalMs` while
/// bytes flow; calls for one transfer run one after another. Report failures are dropped (the next state or progress
/// report carries the truth).
public actor Reporter {
    private let sink: any ReportSink
    private let intervalMs: Int64
    private let now: MillisClock
    private let sleep: Sleeper
    private var status: [String: String] = [:]
    private var verified: [String: Int64] = [:]
    private var lastSent: [String: Int64] = [:]
    private var timers: [String: Task<Void, Never>] = [:]
    private var tails: [String: Task<Void, Never>] = [:]
    public var route: String?
    /// Leaving PAUSED goes through the resume action; returns the status after it, or nil to stay paused.
    private var resume: (@Sendable (String) async -> String?)?

    public init(
        sink: any ReportSink,
        intervalMs: Int64 = 2000,
        now: @escaping MillisClock = systemClock,
        sleep: @escaping Sleeper = systemSleeper
    ) {
        self.sink = sink
        self.intervalMs = intervalMs
        self.now = now
        self.sleep = sleep
    }

    public func setResume(_ f: @escaping @Sendable (String) async -> String?) { resume = f }

    public func setRoute(_ r: String?) { route = r }

    public func seed(_ transferId: String, _ s: String, _ bytes: Int64) {
        status[transferId] = s
        verified[transferId] = bytes
    }

    public func current(_ transferId: String) -> String? { status[transferId] }

    private func bump(_ id: String, _ bytes: Int64?) {
        if let bytes { verified[id] = max(bytes, verified[id] ?? 0) }
    }

    /// Runs `body` after every earlier call for the same transfer.
    private func serial(_ id: String, _ body: @escaping @Sendable () async -> Void) async {
        let prev = tails[id]
        let task = Task {
            await prev?.value
            await body()
        }
        tails[id] = task
        await task.value
    }

    public func state(_ transferId: String, _ target: String, bytes: Int64? = nil) async {
        bump(transferId, bytes)
        await serial(transferId) { await self.walk(transferId, target) }
    }

    private func walk(_ id: String, _ target: String) async {
        var from = status[id] ?? "PENDING"
        if Transitions.terminal(from) { return }
        if from == "PAUSED", target != "PAUSED", Transitions.path(from: from, to: target).isEmpty {
            guard let after = await resume?(id) else { return }
            status[id] = after
            from = after
        }
        for s in Transitions.path(from: from, to: target) where await !send(id, s) {
            return
        }
    }

    public func progress(_ transferId: String, _ bytes: Int64) {
        bump(transferId, bytes)
        if timers[transferId] != nil { return }
        let wait = max(0, (lastSent[transferId] ?? Int64.min / 2) + intervalMs - now())
        timers[transferId] = Task {
            await sleep(wait)
            await self.flushProgress(transferId)
        }
    }

    private func flushProgress(_ id: String) async {
        timers[id] = nil
        if Task.isCancelled { return }
        // Stamped before the report is sent: the actor suspends while sending, and a progress call in that window
        // must wait for the next interval instead of sending again at once.
        lastSent[id] = now()
        await serial(id) {
            guard let s = await self.current(id), !Transitions.terminal(s) else { return }
            await self.send(id, s)
        }
    }

    public func dispose() {
        for t in timers.values {
            t.cancel()
        }
        timers.removeAll()
    }

    @discardableResult
    private func send(_ id: String, _ s: String) async -> Bool {
        let bytes = verified[id] ?? 0
        do {
            let after = try await sink.report(transferId: id, status: s, verifiedBytes: bytes, route: route)
            status[id] = after
            lastSent[id] = now()
            return true
        } catch {
            return false
        }
    }
}

// MARK: - Session result (docs/ARCHITECTURE.md §4.5)

public enum TxStatus: String, Sendable, Equatable {
    case waiting, offline, connecting, transferring, paused, reconnecting, verifying, completed, failed, cancelled, removed, blocked

    public var isActive: Bool { self == .connecting || self == .transferring || self == .reconnecting || self == .verifying }
    public var isEnded: Bool { self == .completed || self == .failed || self == .cancelled || self == .removed || self == .blocked }
    public var isExcluded: Bool { self == .removed || self == .blocked }
}

public enum TxFinal: String, Sendable, Equatable { case completed, partial, failed, cancelled }

/// One receiver as the result rule sees it (the server's EndStatus).
public struct ResultInput: Sendable {
    public var status: TxStatus
    public var delivered: Bool
    public var done: Int
    public var total: Int

    public init(status: TxStatus, delivered: Bool, done: Int, total: Int) {
        self.status = status
        self.delivered = delivered
        self.done = done
        self.total = total
    }
}

public enum SessionResult {
    public static func counts(_ r: ResultInput) -> Bool { !r.status.isExcluded || r.delivered }

    public static func final(_ rs: [ResultInput]) -> TxFinal {
        let counted = rs.filter(counts)
        var total = 0
        var done = 0
        for r in counted {
            total += r.total
            done += (r.status == .completed || r.delivered) ? r.total : min(r.total, r.done)
        }
        if total > 0, done == total { return .completed }
        if done > 0 { return .partial }
        if counted.contains(where: { $0.status == .failed }) { return .failed }
        return .cancelled
    }

    /// The TR-7 result, or nil while undecided (a live session can still take receivers).
    public static func of(_ rs: [ResultInput], ended: Bool) -> TxFinal? {
        if rs.isEmpty { return nil }
        if ended { return final(rs) }
        if !rs.contains(where: counts) || !rs.allSatisfy(\.status.isEnded) { return nil }
        return final(rs)
    }

    /// Group ETA: the slowest active receiver; nil while any active one has no estimate; -1 when nobody is active.
    public static func groupEta(_ rs: [TxReceiver]) -> Int64? {
        let active = rs.filter(\.status.isActive)
        if active.isEmpty { return -1 }
        if active.contains(where: { $0.eta == nil }) { return nil }
        return active.map { $0.eta ?? 0 }.max()
    }

    public static func statusFromServer(_ ts: [String]) -> TxStatus? {
        if ts.isEmpty { return nil }
        if ts.allSatisfy({ $0 == "COMPLETED" }) { return .completed }
        if ts.allSatisfy(Transitions.terminal) { return ts.contains("CANCELLED") && !ts.contains("FAILED") ? .cancelled : .failed }
        if ts.contains("PAUSED") { return .paused }
        if ts.contains(where: { $0 == "DISCONNECTED" || $0 == "RECONNECTING" }) { return .reconnecting }
        if ts.contains(where: { $0 == "TRANSFERRING" || $0 == "RESUMING" }) { return .transferring }
        if ts.contains("CONNECTING") { return .connecting }
        return .waiting
    }
}

public struct TxReceiver: Sendable, Equatable, Identifiable {
    public var participantId: String
    public var name: String
    public var platform: String
    public var joined: Bool
    public var delivered: Bool
    public var status: TxStatus
    public var perFile: [Int64]
    public var verified: Int64
    public var total: Int64
    public var route: String?
    public var bytesPerSecond: Double = 0
    public var eta: Int64?
    /// Catalog error key when failed (product.tx_err_*).
    public var error: String?
    public var id: String { participantId }
}

public struct TxFile: Sendable, Equatable {
    public var index: Int
    public var fileId: String
    public var name: String
    public var size: Int64
    public var mime: String
}

public struct TxState: Sendable, Equatable {
    public var loaded = false
    public var files: [TxFile] = []
    public var receivers: [TxReceiver] = []
    /// This device still holds read access to every picked file.
    public var hasFiles = false
    public var final: TxFinal?
    public var ended = false
    public init() {}

    public var isActive: Bool { receivers.contains { $0.status.isActive } }
}

/// Catalog keys for fatal engine errors (product.tx_err_*), shared by both controllers.
public enum TransferErrorKeys {
    public static func key(_ code: String) -> String {
        switch code {
        case ErrorCode.unauthorized: "product.tx_err_unauthorized"
        case ErrorCode.storageFull: "product.tx_err_storage_full"
        case ErrorCode.storageError: "product.tx_err_storage"
        case ErrorCode.fileUnreadable: "product.tx_err_sender_files"
        case ErrorCode.checksumRetries, ErrorCode.fileHashMismatch: "product.tx_err_checksum"
        default: "product.tx_err_protocol"
        }
    }
}
