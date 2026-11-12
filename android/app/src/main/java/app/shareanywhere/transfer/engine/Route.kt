package app.shareanywhere.transfer.engine

import kotlin.math.max
import kotlin.math.roundToLong

/**
 * Route strategy (docs/ARCHITECTURE.md §6, docs/PRODUCT_REQUIREMENTS.md §6.3): classify the selected ICE candidate
 * pair, and decide when a receiver moves its connection one step stricter (all routes → TURN over UDP → TURN over TLS).
 * Byte for byte with the Web (`web/src/features/transfer/engine/route.ts`) through
 * `shared/protocol/schemas/route-vectors.json`.
 */
enum class RouteKind(val wire: String) {
    DIRECT("direct"),
    RELAY_UDP("relay-udp"),
    RELAY_TCP("relay-tcp"),
    RELAY_TLS("relay-tls"),

    /** Only the remote end relays: relay with an unknown transport. */
    RELAY("relay");

    /** The server's route value. */
    val serverRoute: String get() = if (this == DIRECT) "direct" else "relay"

    companion object {
        fun of(wire: String?): RouteKind? = entries.firstOrNull { it.wire == wire }
    }
}

/** ICE policy steps, from the most permissive. */
enum class PolicyStep(val wire: String) {
    ALL("all"),
    RELAY_UDP("relay-udp"),
    RELAY_TLS("relay-tls");

    val next: PolicyStep? get() = entries.getOrNull(ordinal + 1)

    companion object {
        fun of(wire: String?): PolicyStep? = entries.firstOrNull { it.wire == wire }
    }
}

/** A stats entry with the fields the classifier reads (an RTCStats subset). */
data class StatsEntry(
    val type: String,
    val id: String,
    val selectedCandidatePairId: String? = null,
    val localCandidateId: String? = null,
    val remoteCandidateId: String? = null,
    val currentRoundTripTime: Double? = null,
    val selected: Boolean? = null,
    val nominated: Boolean? = null,
    val state: String? = null,
    val candidateType: String? = null,
    val relayProtocol: String? = null
)

data class Classified(val kind: RouteKind?, val rttMs: Long?)

private fun StatsEntry.isSelectedPair() = selected == true || (nominated == true && state == "succeeded")

object RouteClassifier {
    /** Classifies the selected pair: from the transport's selected pair, else the `selected` pair (Firefox-style). */
    fun classify(stats: List<StatsEntry>): Classified {
        val byId = stats.associateBy { it.id }
        val pairId = stats.lastOrNull { it.type == "transport" && it.selectedCandidatePairId != null }?.selectedCandidatePairId
        val pair =
            pairId?.let { byId[it] }
                ?: stats.lastOrNull { it.type == "candidate-pair" && it.isSelectedPair() }
                ?: return Classified(null, null)
        val local = pair.localCandidateId?.let { byId[it] }
        val remote = pair.remoteCandidateId?.let { byId[it] }
        val rtt = pair.currentRoundTripTime?.let { (it * 1000).roundToLong() }
        val kind =
            when {
                local?.candidateType == "relay" ->
                    when (local.relayProtocol) {
                        "tls" -> RouteKind.RELAY_TLS
                        "tcp" -> RouteKind.RELAY_TCP
                        "udp" -> RouteKind.RELAY_UDP
                        else -> RouteKind.RELAY
                    }
                remote?.candidateType == "relay" -> RouteKind.RELAY
                else -> RouteKind.DIRECT
            }
        return Classified(kind, rtt)
    }
}

data class MonitorConfig(
    val sampleMs: Long = 2_000,
    val stallMs: Long = 12_000,
    val cooldownMs: Long = 30_000,
    val lossWindowMs: Long = 120_000,
    val lossesToEscalate: Int = 2,
    val alpha: Double = 0.3
)

enum class Decision { STAY, MIGRATE }

/**
 * Watches one receiver connection. Hysteresis: a short pause or an RTT spike never migrates; only a stall of `stallMs`
 * without verified progress while connected, or `lossesToEscalate` channel losses on the same step within
 * `lossWindowMs`. A migration advances the step, clears the losses and starts a cooldown; the last step never
 * migrates (the reconnect window then decides, docs/TRANSFER_PROTOCOL.md §6). Not thread-safe: one caller.
 */
class RouteMonitor(var step: PolicyStep = PolicyStep.ALL, private val config: MonitorConfig = MonitorConfig()) {
    private var lastVerified = -1L
    private var lastProgressAt = 0L
    private var started = false
    private var lastMigrationAt = Long.MIN_VALUE / 2
    private var losses = mutableListOf<Long>()
    private var rtt: Double? = null
    private var rate = 0.0
    private var lastSampleAt = 0L

    /** Smoothed round-trip time in ms (null before the first measurement). */
    val rttMs: Long? get() = rtt?.roundToLong()

    /** Smoothed verified bytes per second. */
    val bytesPerSecond: Double get() = rate

    /** Restarts the progress baseline on a new channel. */
    fun rebase(verified: Long, now: Long) {
        lastVerified = verified
        lastProgressAt = now
        lastSampleAt = now
        started = true
    }

    /** One periodic sample of the current connection. */
    fun sample(connected: Boolean, verified: Long, rttMs: Long?, now: Long): Decision {
        val a = config.alpha
        if (rttMs != null) rtt = rtt?.let { a * rttMs + (1 - a) * it } ?: rttMs.toDouble()
        if (!started) {
            rebase(verified, now)
            return Decision.STAY
        }
        val dt = now - lastSampleAt
        if (dt > 0) {
            val r = max(0L, verified - lastVerified) * 1000.0 / dt
            rate = if (rate == 0.0) r else a * r + (1 - a) * rate
        }
        lastSampleAt = now
        if (!connected || verified > lastVerified) {
            lastVerified = max(lastVerified, verified)
            lastProgressAt = now
            return Decision.STAY
        }
        return if (now - lastProgressAt >= config.stallMs) migrate(now) else Decision.STAY
    }

    /**
     * Back to [step] (the receiver's starting step) after dials on a stricter step never opened: the relay is not usable
     * from here. Clears the losses and starts the cooldown, so a later stall or loss pair can migrate again.
     */
    fun reset(step: PolicyStep, now: Long) {
        this.step = step
        losses.clear()
        lastMigrationAt = now
        lastProgressAt = now
    }

    /** A channel that had opened was lost (ICE failed, channel closed). */
    fun lost(now: Long): Decision {
        losses = (losses.filter { now - it < config.lossWindowMs } + now).toMutableList()
        return if (losses.size >= config.lossesToEscalate) migrate(now) else Decision.STAY
    }

    private fun migrate(now: Long): Decision {
        val next = step.next
        if (next == null || now - lastMigrationAt < config.cooldownMs) return Decision.STAY
        step = next
        lastMigrationAt = now
        losses.clear()
        lastProgressAt = now
        return Decision.MIGRATE
    }
}

/**
 * TURN URIs a policy step may use: UDP for relay-udp; TLS for relay-tls (TCP when no TLS URI is configured); all for
 * all. A step with nothing to use keeps every URI rather than none (as the Web's urisForStep).
 */
fun urisForStep(uris: List<String>, step: PolicyStep): List<String> {
    fun udp(u: String) = u.startsWith("turn:") && !u.contains("transport=tcp", ignoreCase = true)
    fun tls(u: String) = u.startsWith("turns:")
    fun tcp(u: String) = u.startsWith("turn:") && u.contains("transport=tcp", ignoreCase = true)
    val pick =
        when (step) {
            PolicyStep.ALL -> uris
            PolicyStep.RELAY_UDP -> uris.filter(::udp)
            PolicyStep.RELAY_TLS -> if (uris.any(::tls)) uris.filter(::tls) else uris.filter(::tcp)
        }
    return pick.ifEmpty { uris }
}
