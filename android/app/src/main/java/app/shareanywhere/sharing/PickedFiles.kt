package app.shareanywhere.sharing

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns

/** A document picked through the Storage Access Framework (TR-2). */
data class PickedFile(val uri: Uri, val name: String, val size: Long, val mime: String)

/** Reads names, sizes and types of picked documents and keeps read access for the transfer engine. */
class PickedFiles(private val resolver: ContentResolver) {
    /** Name, size and type of [uri]; null when the provider does not say how large it is or refuses access. */
    fun describe(uri: Uri): PickedFile? = try {
        var name: String? = null
        var size: Long? = null
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                val n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val s = c.getColumnIndex(OpenableColumns.SIZE)
                if (n >= 0 && !c.isNull(n)) name = c.getString(n)
                if (s >= 0 && !c.isNull(s)) size = c.getLong(s)
            }
        }
        if (size == null) size = resolver.openFileDescriptor(uri, "r")?.use { it.statSize.takeIf { s -> s >= 0 } }
        val n = name?.trim()?.takeIf { it.isNotEmpty() } ?: uri.lastPathSegment?.substringAfterLast('/') ?: "file"
        size?.let { PickedFile(uri, n.take(MAX_NAME), it, resolver.getType(uri) ?: "application/octet-stream") }
    } catch (_: SecurityException) {
        null
    } catch (_: IllegalArgumentException) {
        null
    } catch (_: java.io.IOException) {
        null
    }

    /** Keeps read access across restarts so the transfer engine can stream the file later (6.3). */
    fun persist(uri: Uri): Boolean = try {
        resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        true
    } catch (_: SecurityException) {
        false
    }

    fun release(uri: Uri) {
        try {
            resolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: SecurityException) {
            // Not persisted (or already released): nothing to give back.
        }
    }

    companion object {
        /** File names longer than this are cut (docs/API.md §2.2 validates the name length on the server too). */
        const val MAX_NAME = 255
    }
}
