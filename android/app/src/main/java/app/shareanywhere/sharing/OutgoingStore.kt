package app.shareanywhere.sharing

import androidx.core.net.toUri
import app.shareanywhere.transfer.OutgoingFile
import app.shareanywhere.transfer.OutgoingFileDao
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Picked files offered in this device's sessions, and the persisted read access that goes with them. */
class OutgoingStore(private val dao: OutgoingFileDao, private val picked: PickedFiles) {
    /** Keeps read access to every file and maps it to the server's file id, in the order the server stores. */
    suspend fun save(sessionId: String, serverIds: List<Pair<String, PickedFile>>, now: Long) = withContext(Dispatchers.IO) {
        val rows =
            serverIds.mapIndexed { i, (fileId, f) ->
                picked.persist(f.uri)
                OutgoingFile(sessionId, fileId, i, f.uri.toString(), f.name, f.size, f.mime, now)
            }
        dao.insertAll(rows)
    }

    suspend fun has(sessionId: String): Boolean = withContext(Dispatchers.IO) { dao.count(sessionId) > 0 }

    /** Forgets a session's files (it ended) and gives back read access no other session still needs. */
    suspend fun release(sessionId: String) = withContext(Dispatchers.IO) {
        val rows = dao.forSession(sessionId)
        if (rows.isEmpty()) return@withContext
        dao.deleteSession(sessionId)
        val stillUsed = dao.uris().toSet()
        rows.map { it.uri }.distinct().filter { it !in stillUsed }.forEach { picked.release(it.toUri()) }
    }
}
