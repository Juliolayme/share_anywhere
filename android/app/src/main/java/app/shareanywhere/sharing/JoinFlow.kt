package app.shareanywhere.sharing

import app.shareanywhere.data.api.JoinPreview

/** How a preview was opened, so a lapsed five-minute join ticket can be renewed while the window is open. */
sealed interface JoinSource {
    data class Code(val code: String) : JoinSource

    data class Link(val token: String) : JoinSource
}

data class PendingJoin(val preview: JoinPreview, val offset: Long, val source: JoinSource)

/**
 * Hands a resolved preview from RX-1/RX-2/RX-3 to RX-4 (navigation arguments carry only the session id). Kept in
 * memory only: after process death the preview screen sends the user back to Receive, as the Web does after a reload.
 */
class JoinFlow {
    @Volatile private var pending: PendingJoin? = null

    fun put(join: PendingJoin) {
        pending = join
    }

    fun get(sessionId: String): PendingJoin? = pending?.takeIf { it.preview.sessionId == sessionId }

    fun clear() {
        pending = null
    }
}
