package app.shareanywhere.transfer.runtime

/**
 * Client mirror of the server's transfer state machine (backend/internal/transfers/model.go, docs/ARCHITECTURE.md
 * §4.5), as the Web's transitions.ts. The server validates every report; the client walks to a target state through
 * allowed steps.
 */
object Transitions {
    val NEXT: Map<String, List<String>> =
        mapOf(
            "PENDING" to listOf("CONNECTING", "PAUSED", "FAILED", "CANCELLED"),
            "CONNECTING" to listOf("TRANSFERRING", "RESUMING", "DISCONNECTED", "PAUSED", "FAILED", "CANCELLED"),
            "TRANSFERRING" to listOf("PAUSED", "DISCONNECTED", "COMPLETED", "FAILED", "CANCELLED"),
            "PAUSED" to listOf("CONNECTING", "RESUMING", "TRANSFERRING", "COMPLETED", "FAILED", "CANCELLED"),
            "DISCONNECTED" to listOf("RECONNECTING", "CONNECTING", "PAUSED", "FAILED", "CANCELLED"),
            "RECONNECTING" to listOf("RESUMING", "CONNECTING", "DISCONNECTED", "PAUSED", "FAILED", "CANCELLED"),
            "RESUMING" to listOf("TRANSFERRING", "DISCONNECTED", "PAUSED", "COMPLETED", "FAILED", "CANCELLED"),
            "COMPLETED" to emptyList(),
            "FAILED" to emptyList(),
            "CANCELLED" to emptyList()
        )

    fun terminal(s: String) = s == "COMPLETED" || s == "FAILED" || s == "CANCELLED"

    /**
     * Shortest list of states to report from [from] to [to] (empty when already there or unreachable). Never passes
     * through PAUSED on the way elsewhere and never leaves PAUSED except to a terminal state (`use_resume`).
     */
    fun pathTo(from: String, to: String): List<String> {
        if (from == to) return emptyList()
        if (from == "PAUSED") return if (terminal(to) && to in NEXT.getValue("PAUSED")) listOf(to) else emptyList()
        val prev = HashMap<String, String>()
        val queue = ArrayDeque(listOf(from))
        while (queue.isNotEmpty()) {
            val cur = queue.removeFirst()
            for (n in NEXT[cur].orEmpty()) {
                if (n == from || n in prev || (n == "PAUSED" && to != "PAUSED")) continue
                prev[n] = cur
                if (n == to) {
                    val path = ArrayDeque(listOf(to))
                    var p = cur
                    while (p != from) {
                        path.addFirst(p)
                        p = prev.getValue(p)
                    }
                    return path.toList()
                }
                queue.addLast(n)
            }
        }
        return emptyList()
    }
}
