import Foundation

/// Client mirror of the server's transfer state machine (backend/internal/transfers/model.go, docs/ARCHITECTURE.md
/// §4.5), as the Web's transitions.ts and Android's `Transitions`. The server validates every report; the client walks
/// to a target state through allowed steps.
public enum Transitions {
    public static let next: [String: [String]] = [
        "PENDING": ["CONNECTING", "PAUSED", "FAILED", "CANCELLED"],
        "CONNECTING": ["TRANSFERRING", "RESUMING", "DISCONNECTED", "PAUSED", "FAILED", "CANCELLED"],
        "TRANSFERRING": ["PAUSED", "DISCONNECTED", "COMPLETED", "FAILED", "CANCELLED"],
        "PAUSED": ["CONNECTING", "RESUMING", "TRANSFERRING", "COMPLETED", "FAILED", "CANCELLED"],
        "DISCONNECTED": ["RECONNECTING", "CONNECTING", "PAUSED", "FAILED", "CANCELLED"],
        "RECONNECTING": ["RESUMING", "CONNECTING", "DISCONNECTED", "PAUSED", "FAILED", "CANCELLED"],
        "RESUMING": ["TRANSFERRING", "DISCONNECTED", "PAUSED", "COMPLETED", "FAILED", "CANCELLED"],
        "COMPLETED": [],
        "FAILED": [],
        "CANCELLED": []
    ]

    public static func terminal(_ s: String) -> Bool { s == "COMPLETED" || s == "FAILED" || s == "CANCELLED" }

    /// Shortest list of states to report from `from` to `to` (empty when already there or unreachable). Never passes
    /// through PAUSED on the way elsewhere and never leaves PAUSED except to a terminal state (`use_resume`).
    public static func path(from: String, to: String) -> [String] {
        if from == to { return [] }
        if from == "PAUSED" { return terminal(to) && (next["PAUSED"] ?? []).contains(to) ? [to] : [] }
        var prev: [String: String] = [:]
        var queue = [from]
        var head = 0
        while head < queue.count {
            let cur = queue[head]
            head += 1
            for n in next[cur] ?? [] {
                if n == from || prev[n] != nil || (n == "PAUSED" && to != "PAUSED") { continue }
                prev[n] = cur
                if n == to {
                    var path = [to]
                    var p = cur
                    while p != from {
                        path.insert(p, at: 0)
                        p = prev[p]!
                    }
                    return path
                }
                queue.append(n)
            }
        }
        return []
    }
}

/// Throughput and ETA (PRD §6.5), as the Web's eta.ts: EWMA of verified bytes per second; the ETA is provisional
/// until 3 %, while reconnecting, after 10 s without progress, or beyond a week.
public struct Throughput: Sendable {
    private let alpha: Double
    private let minIntervalMs: Int64
    private var rate = 0.0
    private var lastBytes: Int64 = 0
    private var lastAt: Int64 = 0
    private var lastProgressAt: Int64 = 0
    private var started = false
    static let stallMs: Int64 = 10000
    static let maxSeconds: Int64 = 7 * 24 * 3600

    public init(alpha: Double = 0.3, minIntervalMs: Int64 = 400) {
        self.alpha = alpha
        self.minIntervalMs = minIntervalMs
    }

    public mutating func sample(_ verified: Int64, now: Int64) {
        if !started {
            started = true
            lastBytes = verified
            lastAt = now
            lastProgressAt = now
            return
        }
        let dt = now - lastAt
        if dt < minIntervalMs { return }
        if verified > lastBytes { lastProgressAt = now }
        let r = Double(max(0, verified - lastBytes)) * 1000 / Double(dt)
        rate = rate == 0 ? r : alpha * r + (1 - alpha) * rate
        lastBytes = verified
        lastAt = now
    }

    /// Bytes per second and seconds left (nil while provisional).
    public func estimate(_ verified: Int64, total: Int64, reconnecting: Bool = false) -> (bytesPerSecond: Double, eta: Int64?) {
        let progress = total > 0 ? Double(verified) / Double(total) : 1
        let stalled = lastAt - lastProgressAt >= Throughput.stallMs
        let provisional = reconnecting || progress <= 0.03 || rate <= 0 || stalled
        var seconds: Int64?
        if !provisional { seconds = max(0, Int64((Double(total - verified) / rate).rounded(.up))) }
        if let s = seconds, s > Throughput.maxSeconds { seconds = nil }
        return (stalled ? 0 : rate, seconds)
    }
}

/// Redial delay after a lost connection: 1 s doubling to 15 s, ±25 % jitter (docs/TRANSFER_PROTOCOL.md §6).
public func redialDelayMs(_ attempt: Int, random: Double) -> Int64 {
    Int64(min(15000, 1000 * pow(2, Double(min(attempt, 10)))) * (0.75 + random * 0.5))
}

/// WebSocket reconnect delay: 1 s, 2 s, 4 s … capped at 30 s, ±25 % (docs/API.md §4).
public func socketBackoffMs(_ attempt: Int, random: Double) -> Int64 {
    Int64(min(30000, 1000 * pow(2, Double(min(attempt, 15)))) * (0.75 + random * 0.5))
}
