package app.shareanywhere.transfer.storage

import android.content.ContentResolver
import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.system.ErrnoException
import android.system.OsConstants
import app.shareanywhere.transfer.engine.FileChangedException
import app.shareanywhere.transfer.engine.FileSource
import app.shareanywhere.transfer.engine.Sink
import app.shareanywhere.transfer.engine.StorageFullException
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** ENOSPC anywhere in the cause chain means the device is full (ERROR storage_full). */
private fun IOException.mapFull(): IOException {
    var c: Throwable? = this
    while (c != null) {
        if (c is ErrnoException && c.errno == OsConstants.ENOSPC) return StorageFullException(message ?: "No space left on device")
        if (c.message?.contains("ENOSPC") == true ||
            c.message?.contains("No space left") == true
        ) {
            return StorageFullException(c.message ?: "No space left on device")
        }
        c = c.cause
    }
    return this
}

/**
 * A received file written straight into the document the receiver's folder holds, at block offsets (positional
 * writes through the document's file descriptor), so a 20 GB transfer never needs memory or a staging copy.
 */
class SafSink(private val resolver: ContentResolver, private val uri: Uri) :
    Sink,
    AutoCloseable {
    private var pfd: ParcelFileDescriptor? = null
    private var out: FileOutputStream? = null

    private fun open(): FileOutputStream = out ?: run {
        val fd = resolver.openFileDescriptor(uri, "rw") ?: throw IOException("Cannot open $uri for writing")
        pfd = fd
        FileOutputStream(fd.fileDescriptor).also { out = it }
    }

    override suspend fun write(offset: Long, data: ByteArray) = withContext(Dispatchers.IO) {
        try {
            val ch = open().channel
            val buf = ByteBuffer.wrap(data)
            var pos = offset
            while (buf.hasRemaining()) pos += ch.write(buf, pos)
        } catch (e: IOException) {
            throw e.mapFull()
        }
    }

    override suspend fun read(offset: Long, length: Int): ByteArray = withContext(Dispatchers.IO) {
        resolver.openFileDescriptor(uri, "r")?.use { fd ->
            FileInputStream(fd.fileDescriptor).use { input ->
                val ch = input.channel
                val buf = ByteBuffer.allocate(length)
                var pos = offset
                while (buf.hasRemaining()) {
                    val n = ch.read(buf, pos)
                    if (n < 0) break
                    pos += n
                }
                if (buf.position() != length) throw IOException("short read at $offset")
                buf.array()
            }
        } ?: throw IOException("Cannot open $uri for reading")
    }

    override suspend fun flush() = withContext(Dispatchers.IO) {
        try {
            out?.fd?.sync()
            Unit
        } catch (e: IOException) {
            throw e.mapFull()
        }
    }

    override fun close() {
        runCatching { out?.close() }
        runCatching { pfd?.close() }
        out = null
        pfd = null
    }
}

/**
 * A picked document read in slices with positional reads (never loaded whole). A read shorter than asked means the
 * file shrank since it was picked ([FileChangedException], ERROR file_unreadable).
 */
class SafSource(private val resolver: ContentResolver, private val uri: Uri, override val size: Long) :
    FileSource,
    AutoCloseable {
    private var pfd: ParcelFileDescriptor? = null
    private var input: FileInputStream? = null

    private fun open(): FileInputStream = input ?: run {
        val fd = resolver.openFileDescriptor(uri, "r") ?: throw IOException("Cannot open the picked file")
        pfd = fd
        FileInputStream(fd.fileDescriptor).also { input = it }
    }

    override suspend fun read(offset: Long, length: Int): ByteArray = withContext(Dispatchers.IO) {
        val ch = open().channel
        val buf = ByteBuffer.allocate(length)
        var pos = offset
        while (buf.hasRemaining()) {
            val n = ch.read(buf, pos)
            if (n < 0) break
            pos += n
        }
        if (buf.position() != length) throw FileChangedException("The file changed while it was being sent.")
        buf.array()
    }

    override fun close() {
        runCatching { input?.close() }
        runCatching { pfd?.close() }
        input = null
        pfd = null
    }
}

/**
 * Where received files are created: the default `Download/Share Anywhere` through MediaStore (API 29+, no permission,
 * the design's "Saved to Download/Share Anywhere"), or a folder the receiver chose with OpenDocumentTree (grant
 * persisted).
 */
object Folders {
    /** The SaveTarget tree value for the default Downloads folder. */
    const val DEFAULT_DOWNLOADS = "mediastore:downloads"
    const val DEFAULT_LABEL = "Download/Share Anywhere"

    val defaultAvailable: Boolean get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q

    /** A new document named [name]; the provider picks a free name ("trip (1).mp4") on collisions. */
    fun create(resolver: ContentResolver, target: String, name: String, mime: String): Uri {
        val type = mime.ifBlank { "application/octet-stream" }
        if (target == DEFAULT_DOWNLOADS) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) throw IOException("Downloads needs Android 10")
            val values =
                ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, safeName(name))
                    put(MediaStore.MediaColumns.MIME_TYPE, type)
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Share Anywhere")
                    // Hidden from other apps until every byte is verified (finish clears it).
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
            return resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw IOException("Downloads refused a new file")
        }
        val tree = Uri.parse(target)
        val parent = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        return DocumentsContract.createDocument(resolver, parent, type, safeName(name))
            ?: throw IOException("The folder refused a new file")
    }

    /** The file was verified end to end: publish it (MediaStore pending flag off). */
    fun finish(resolver: ContentResolver, doc: Uri) {
        if (doc.authority != MediaStore.AUTHORITY || !defaultAvailable) return
        runCatching { resolver.update(doc, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null) }
    }

    fun delete(resolver: ContentResolver, doc: Uri) {
        runCatching {
            if (doc.authority == MediaStore.AUTHORITY) resolver.delete(doc, null, null) else DocumentsContract.deleteDocument(resolver, doc)
        }
    }

    /** The document still exists (resume after a restart). */
    fun exists(resolver: ContentResolver, doc: Uri): Boolean = runCatching {
        resolver.openFileDescriptor(doc, "r")?.use { true } == true
    }.getOrDefault(false)

    /** Display name of a document (the name the provider chose). */
    fun displayName(resolver: ContentResolver, doc: Uri): String? = runCatching {
        resolver.query(doc, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    }.getOrNull()

    /** File names never carry path separators or control characters from the sender. */
    fun safeName(name: String): String =
        name.replace(Regex("[\\\\/:*?\"<>|\\x00-\\x1F]"), "_").trim().trimStart('.').ifEmpty { "file" }.take(200)
}
