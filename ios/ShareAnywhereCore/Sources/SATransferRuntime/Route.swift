import Foundation

// Route strategy (docs/ARCHITECTURE.md §6, docs/PRODUCT_REQUIREMENTS.md §6.3): classify the selected ICE candidate
// pair, and decide when a receiver moves its connection one step stricter (all routes → TURN over UDP → TURN over TLS).
// Byte for byte with the Web (`web/src/features/transfer/engine/route.ts`) and Android (`transfer/engine/Route.kt`)
// through `shared/protocol/schemas/route-vectors.json`.

/// What the selected candidate pair runs over. `relay` alone: only the remote end relays (transport unknown).
public enum RouteKind: String, Sendable, Equatable, CaseIterable {
    case direct
    case relayUdp = "relay-udp"
    case relayTcp = "relay-tcp"
    case relayTls = "relay-tls"
    case relay

    /// The server's route value.
    public var serverRoute: String { self == .direct ? "direct" : "relay" }
}

/// ICE policy steps, from the most permissive.
public enum PolicyStep: String, Sendable, Equatable, CaseIterable {
    case all
    case relayUdp = "relay-udp"
    case relayTls = "relay-tls"

    /// The next stricter step; nil on the last one.
    public var next: PolicyStep? {
        let all = Self.allCases
        guard let i = all.firstIndex(of: self), i + 1 < all.count else { return nil }
        return all[i + 1]
    }

    /// Any step but `all` gathers relay candidates only.
    public var relayOnly: Bool { self != .all }
}

/// A stats entry with the fields the classifier reads (an RTCStats subset).
public struct StatsEntry: Sendable, Equatable {
    public var type: String
    public var id: String
    public var selectedCandidatePairId: String?
    public var localCandidateId: String?
    public var remoteCandidateId: String?
    public var currentRoundTripTime: Double?
    public var selected: Bool?
    public var nominated: Bool?
    public var state: String?
    public var candidateType: String?
    public var relayProtocol: String?

    public init(
        type: String, id: String, selectedCandidatePairId: String? = nil, localCandidateId: String? = nil,
        remoteCandidateId: String? = nil, currentRoundTripTime: Double? = nil, selected: Bool? = nil, nominated: Bool? = nil,
        state: String? = nil, candidateType: String? = nil, relayProtocol: String? = nil
    ) {
        self.type = type
        self.id = id
        self.selectedCandidatePairId = selectedCandidatePairId
        self.localCandidateId = localCandidateId
        self.remoteCandidateId = remoteCandidateId
        self.currentRoundTripTime = currentRoundTripTime
        self.selected = selected
        self.nominated = nominated
        self.state = state
        self.candidateType = candidateType
        self.relayProtocol = relayProtocol
    }

    var isSelectedPair: Bool { selected == true || (nominated == true && state == "succeeded") }
}

public struct Classified: Sendable, Equatable {
    public var kind: RouteKind?
    public var rttMs: Int64?

    public init(kind: RouteKind?, rttMs: Int64?) {
        self.kind = kind
        self.rttMs = rttMs
    }
}

/// Classifies the selected pair: from the transport's selected pair, else the `selected` pair (Firefox-style).
public func classifyRoute(_ stats: [StatsEntry]) -> Classified {
    var byId: [String: StatsEntry] = [:]
    for s in stats {
        byId[s.id] = s
    }
    let pairId = stats.last(where: { $0.type == "transport" && $0.selectedCandidatePairId != nil })?.selectedCandidatePairId
    guard let pair = pairId.flatMap({ byId[$0] }) ?? stats.last(where: { $0.type == "candidate-pair" && $0.isSelectedPair }) else {
        return Classified(kind: nil, rttMs: nil)
    }
    let local = pair.localCandidateId.flatMap { byId[$0] }
    let remote = pair.remoteCandidateId.flatMap { byId[$0] }
    let rtt = pair.currentRoundTripTime.map { Int64(($0 * 1000).rounded()) }
    let kind: RouteKind = if local?.candidateType == "relay" {
        switch local?.relayProtocol {
        case "tls": .relayTls
        case "tcp": .relayTcp
        case "udp": .relayUdp
        default: .relay
        }
    } else if remote?.candidateType == "relay" {
        .relay
    } else {
        .direct
    }
    return Classified(kind: kind, rttMs: rtt)
}

public struct MonitorConfig: Sendable, Equatable {
    public var sampleMs: Int64 = 2000
    public var stallMs: Int64 = 12000
    public var cooldownMs: Int64 = 30000
    public var lossWindowMs: Int64 = 120_000
    public var lossesToEscalate = 2
    public var alpha = 0.3

    public init() {}
}

public enum RouteDecision: String, Sendable, Equatable {
    case stay, migrate
}

/// Watches one receiver connection. Hysteresis: a short pause or an RTT spike never migrates; only a stall of `stallMs`
/// without verified progress while connected, or `lossesToEscalate` channel losses on the same step within
/// `lossWindowMs`. A migration advances the step, clears the losses and starts a cooldown; the last step never
/// migrates (the reconnect window then decides, docs/TRANSFER_PROTOCOL.md §6). Not thread-safe: one owner (the
/// receiver controller's actor).
public struct RouteMonitor: Sendable {
    public private(set) var step: PolicyStep
    private let config: MonitorConfig
    private var lastVerified: Int64 = -1
    private var lastProgressAt: Int64 = 0
    private var started = false
    private var lastMigrationAt: Int64 = .min / 2
    private var losses: [Int64] = []
    private var rtt: Double?
    private var rate = 0.0
    private var lastSampleAt: Int64 = 0

    public init(step: PolicyStep = .all, config: MonitorConfig = MonitorConfig()) {
        self.step = step
        self.config = config
    }

    /// Smoothed round-trip time in ms (nil before the first measurement).
    public var rttMs: Int64? { rtt.map { Int64($0.rounded()) } }

    /// Smoothed verified bytes per second.
    public var bytesPerSecond: Double { rate }

    /// Restarts the progress baseline on a new channel.
    public mutating func rebase(verified: Int64, now: Int64) {
        lastVerified = verified
        lastProgressAt = now
        lastSampleAt = now
        started = true
    }

    /// One periodic sample of the current connection.
    public mutating func sample(connected: Bool, verified: Int64, rttMs: Int64?, now: Int64) -> RouteDecision {
        let a = config.alpha
        if let rttMs {
            rtt = rtt.map { a * Double(rttMs) + (1 - a) * $0 } ?? Double(rttMs)
        }
        if !started {
            rebase(verified: verified, now: now)
            return .stay
        }
        let dt = now - lastSampleAt
        if dt > 0 {
            let r = Double(max(0, verified - lastVerified)) * 1000 / Double(dt)
            rate = rate == 0 ? r : a * r + (1 - a) * rate
        }
        lastSampleAt = now
        if !connected || verified > lastVerified {
            lastVerified = max(lastVerified, verified)
            lastProgressAt = now
            return .stay
        }
        return now - lastProgressAt >= config.stallMs ? migrate(now) : .stay
    }

    /// The channel was lost (ICE failed, channel closed).
    public mutating func lost(now: Int64) -> RouteDecision {
        losses = losses.filter { now - $0 < config.lossWindowMs } + [now]
        return losses.count >= config.lossesToEscalate ? migrate(now) : .stay
    }

    private mutating func migrate(_ now: Int64) -> RouteDecision {
        guard let next = step.next, now - lastMigrationAt >= config.cooldownMs else { return .stay }
        step = next
        lastMigrationAt = now
        losses.removeAll()
        lastProgressAt = now
        return .migrate
    }
}

/// TURN URIs a policy step may use: UDP for relay-udp; TLS for relay-tls (TCP when no TLS URI is configured); all for
/// all. A step with nothing to use keeps every URI rather than none (as the Web's urisForStep).
public func urisForStep(_ uris: [String], _ step: PolicyStep) -> [String] {
    func tcpTransport(_ u: String) -> Bool { u.range(of: "transport=tcp", options: .caseInsensitive) != nil }
    let udp = { (u: String) in u.hasPrefix("turn:") && !tcpTransport(u) }
    let tls = { (u: String) in u.hasPrefix("turns:") }
    let tcp = { (u: String) in u.hasPrefix("turn:") && tcpTransport(u) }
    let pick: [String] = switch step {
    case .all: uris
    case .relayUdp: uris.filter(udp)
    case .relayTls: uris.filter(uris.contains(where: tls) ? tls : tcp)
    }
    return pick.isEmpty ? uris : pick
}

/// A receiver's dial on a policy step (as the Web's `rtcSetup` and Android's `Rtc.setup`).
public struct RtcSetup: Sendable, Equatable {
    public var servers: [ICEServer]
    public var relayOnly: Bool
    /// The server refused TURN credentials (`relay_cap_reached`, `rate_limited`, … or `network`); nil when issued.
    public var turnRefused: String?
    /// When the TURN credential expires (ms since 1970), so a relayed connection is renewed before it lapses.
    public var expiresAt: Int64?
}

public func rtcSetup(_ transfers: any TransferService, sessionId: String, step: PolicyStep) async -> RtcSetup {
    do {
        let c = try await transfers.turn(sessionId: sessionId)
        return RtcSetup(
            servers: ICEServer.from(c, step: step), relayOnly: step.relayOnly, turnRefused: nil, expiresAt: parseInstantMs(c.expiresAt)
        )
    } catch let e as APIError {
        return RtcSetup(servers: [], relayOnly: step.relayOnly, turnRefused: e.code, expiresAt: nil)
    } catch {
        // Without TURN credentials, direct (host or LAN) candidates may still connect.
        return RtcSetup(servers: [], relayOnly: step.relayOnly, turnRefused: "network", expiresAt: nil)
    }
}

/// An RFC 3339 instant (with or without fractional seconds) as ms since 1970.
func parseInstantMs(_ s: String) -> Int64? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return Int64(d.timeIntervalSince1970 * 1000) }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: s).map { Int64($0.timeIntervalSince1970 * 1000) }
}
