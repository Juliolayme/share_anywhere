package app.shareanywhere.transfer.runtime

import kotlin.math.ceil
import kotlin.math.max

/**
 * Throughput and ETA (PRD §6.5), as the Web's eta.ts: EWMA of verified bytes per second; the ETA is provisional until
 * 3 %, while reconnecting, after 10 s without progress, or beyond a week.
 */
class Throughput(private val alpha: Double = 0.3, private val minIntervalMs: Long = 400) {
    private var rate = 0.0
    private var lastBytes = 0L
    private var lastAt = 0L
    private var lastProgressAt = 0L
    private var started = false

    fun sample(verified: Long, now: Long) {
        if (!started) {
            started = true
            lastBytes = verified
            lastAt = now
            lastProgressAt = now
            return
        }
        val dt = now - lastAt
        if (dt < minIntervalMs) return
        if (verified > lastBytes) lastProgressAt = now
        val r = max(0L, verified - lastBytes) * 1000.0 / dt
        rate = if (rate == 0.0) r else alpha * r + (1 - alpha) * rate
        lastBytes = verified
        lastAt = now
    }

    /** Bytes per second and seconds left (null while provisional). */
    fun estimate(verified: Long, total: Long, reconnecting: Boolean = false): Pair<Double, Long?> {
        val progress = if (total > 0) verified.toDouble() / total else 1.0
        val stalled = lastAt - lastProgressAt >= STALL_MS
        val provisional = reconnecting || progress <= 0.03 || rate <= 0 || stalled
        val seconds = if (provisional) null else max(0L, ceil((total - verified) / rate).toLong())
        return (if (stalled) 0.0 else rate) to seconds?.takeIf { it <= MAX_SECONDS }
    }

    private companion object {
        const val STALL_MS = 10_000L
        const val MAX_SECONDS = 7L * 24 * 3600
    }
}
