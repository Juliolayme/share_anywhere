package app.shareanywhere.transfer.runtime

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** What the reporter needs from the server: `POST /v1/transfers/{id}/report` and the resume action. */
interface ReportSink {
    /** Returns the server's new status. */
    suspend fun report(transferId: String, status: String, verifiedBytes: Long, route: String?): String
}

/**
 * Reports one receiver's transfer states (docs/TRANSFER_PROTOCOL.md §7), as the Web's Reporter: state changes at
 * once through allowed intermediate states, progress at most every [intervalMs] while bytes flow; calls for one
 * transfer are serialized. Report failures are dropped (the next state or progress report carries the truth).
 */
class Reporter(
    private val sink: ReportSink,
    private val scope: CoroutineScope,
    private val intervalMs: Long = 2000,
    private val now: () -> Long = System::currentTimeMillis
) {
    private val status = HashMap<String, String>()
    private val verified = HashMap<String, Long>()
    private val lastSent = HashMap<String, Long>()
    private val locks = HashMap<String, Mutex>()
    private val timers = HashMap<String, Job>()
    private val guard = Any()

    @Volatile var route: String? = null

    /** Leaving PAUSED goes through the resume action; returns the status after it, or null to stay paused. */
    @Volatile var resume: (suspend (transferId: String) -> String?)? = null

    fun seed(transferId: String, s: String, bytes: Long) = synchronized(guard) {
        status[transferId] = s
        verified[transferId] = bytes
    }

    fun current(transferId: String): String? = synchronized(guard) { status[transferId] }

    private fun lock(id: String) = synchronized(guard) { locks.getOrPut(id) { Mutex() } }

    private fun bump(id: String, bytes: Long?) = synchronized(guard) {
        if (bytes != null) verified[id] = maxOf(bytes, verified[id] ?: 0)
    }

    suspend fun state(transferId: String, target: String, bytes: Long? = null) {
        bump(transferId, bytes)
        lock(transferId).withLock {
            var from = current(transferId) ?: "PENDING"
            if (Transitions.terminal(from)) return
            if (from == "PAUSED" && target != "PAUSED" && Transitions.pathTo(from, target).isEmpty()) {
                val after = runCatching { resume?.invoke(transferId) }.getOrNull() ?: return
                synchronized(guard) { status[transferId] = after }
                from = after
            }
            for (s in Transitions.pathTo(from, target)) if (!send(transferId, s)) return
        }
    }

    fun progress(transferId: String, bytes: Long) {
        bump(transferId, bytes)
        synchronized(guard) {
            if (timers[transferId]?.isActive == true) return
            val wait = maxOf(0L, (lastSent[transferId] ?: Long.MIN_VALUE / 2) + intervalMs - now())
            timers[transferId] =
                scope.launch {
                    delay(wait)
                    lock(transferId).withLock {
                        val s = current(transferId)
                        if (s != null && !Transitions.terminal(s)) send(transferId, s)
                    }
                }
        }
    }

    fun dispose() = synchronized(guard) {
        timers.values.forEach { it.cancel() }
        timers.clear()
    }

    private suspend fun send(transferId: String, s: String): Boolean = try {
        val bytes = synchronized(guard) { verified[transferId] ?: 0 }
        val after = sink.report(transferId, s, bytes, route)
        synchronized(guard) {
            status[transferId] = after
            lastSent[transferId] = now()
        }
        true
    } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
    } catch (_: Exception) {
        false
    }
}
