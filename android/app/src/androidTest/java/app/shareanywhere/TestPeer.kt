package app.shareanywhere

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import app.shareanywhere.data.api.TransfersApi
import app.shareanywhere.data.ws.SessionSocket
import app.shareanywhere.history.HistoryDatabase
import app.shareanywhere.history.HistoryRepository
import app.shareanywhere.transfer.OutgoingFile
import app.shareanywhere.transfer.TransferDatabase
import app.shareanywhere.transfer.runtime.ReceiverController
import app.shareanywhere.transfer.runtime.ReceiverDeps
import app.shareanywhere.transfer.runtime.SenderController
import app.shareanywhere.transfer.runtime.SenderDeps
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

/**
 * The other device in a transfer test: a second guest identity in the test process, with its own WebSocket, transfer
 * controllers (the app's own engine and WebRTC stack) and in-memory databases, talking to the same CI backend.
 */
class TestPeer(val peer: Backend.Peer) : AutoCloseable {
    val context: Context = ApplicationProvider.getApplicationContext()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    val socket = SessionSocket(checkNotNull(Backend.url), Backend.http, Backend.json, scope, ticket = { peer.api.wsTicket().ticket })
    val transfers = TransfersApi(peer.client, peer.auth)
    private val db = Room.inMemoryDatabaseBuilder(context, TransferDatabase::class.java).build()
    private val historyDb = Room.inMemoryDatabaseBuilder(context, HistoryDatabase::class.java).build()
    val history = HistoryRepository(historyDb.history())
    private val controllers = mutableListOf<() -> Unit>()

    /** Offers [file] in [sessionId] (created by this peer); the sender answers the app's offers once [SenderController.init] ran. */
    suspend fun sender(sessionId: String, file: File, fileId: String, mime: String): SenderController {
        db.outgoing().insertAll(
            listOf(
                OutgoingFile(
                    sessionId,
                    fileId,
                    0,
                    android.net.Uri.fromFile(file).toString(),
                    file.name,
                    file.length(),
                    mime,
                    System.currentTimeMillis()
                )
            )
        )
        return SenderController(SenderDeps(context, sessionId, peer.api, transfers, socket, db.outgoing(), history, Backend.json)).also {
            it.init()
            controllers += { it.dispose() }
        }
    }

    fun receiver(sessionId: String): ReceiverController =
        ReceiverController(ReceiverDeps(context, sessionId, peer.api, transfers, socket, db.incoming(), history, Backend.json)).also {
            it.init()
            controllers += { it.dispose() }
        }

    override fun close() {
        controllers.forEach { runCatching { it() } }
        db.close()
        historyDb.close()
        scope.cancel()
    }

    companion object {
        /** A file of [size] deterministic bytes in the app's cache, and its SHA-256. */
        fun file(name: String, size: Int): Pair<File, String> {
            val f = File(ApplicationProvider.getApplicationContext<Context>().cacheDir, name)
            val md = MessageDigest.getInstance("SHA-256")
            f.outputStream().buffered().use { out ->
                val chunk = ByteArray(64 * 1024)
                var written = 0
                var x = 1
                while (written < size) {
                    val n = minOf(chunk.size, size - written)
                    for (i in 0 until n) {
                        x = x xor (x shl 13)
                        x = x xor (x ushr 17)
                        x = x xor (x shl 5)
                        chunk[i] = x.toByte()
                    }
                    out.write(chunk, 0, n)
                    md.update(chunk, 0, n)
                    written += n
                }
            }
            return f to md.digest().joinToString("") { "%02x".format(it) }
        }

        /** SHA-256 of a received document. */
        fun sha256(context: Context, uri: android.net.Uri): String {
            val md = MessageDigest.getInstance("SHA-256")
            context.contentResolver.openInputStream(uri)!!.use { input ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    md.update(buf, 0, n)
                }
            }
            return md.digest().joinToString("") { "%02x".format(it) }
        }
    }
}
