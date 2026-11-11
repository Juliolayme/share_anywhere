package app.shareanywhere.transfer

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.RoomDatabase

/**
 * A file this device offers in one of its share sessions: the server's file id mapped to the document the user
 * picked through the Storage Access Framework. The URI permission is persisted when the file is picked, so the
 * transfer engine (milestone 6.3) can read it after the app restarts. Nothing here leaves the device.
 */
@Entity(tableName = "outgoing_files", primaryKeys = ["session_id", "file_id"])
data class OutgoingFile(
    @ColumnInfo(name = "session_id") val sessionId: String,
    @ColumnInfo(name = "file_id") val fileId: String,
    val position: Int,
    val uri: String,
    val name: String,
    val size: Long,
    val mime: String,
    @ColumnInfo(name = "created_at") val createdAt: Long
)

@Dao
interface OutgoingFileDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(files: List<OutgoingFile>)

    @Query("SELECT * FROM outgoing_files WHERE session_id = :sessionId ORDER BY position")
    suspend fun forSession(sessionId: String): List<OutgoingFile>

    @Query("SELECT COUNT(*) FROM outgoing_files WHERE session_id = :sessionId")
    suspend fun count(sessionId: String): Int

    @Query("DELETE FROM outgoing_files WHERE session_id = :sessionId")
    suspend fun deleteSession(sessionId: String)

    @Query("SELECT DISTINCT uri FROM outgoing_files")
    suspend fun uris(): List<String>

    @Query("DELETE FROM outgoing_files WHERE created_at < :cutoff")
    suspend fun deleteOlderThan(cutoff: Long): Int
}

/** Transfer state kept on the device: picked files now, transfer bitmaps with the engine (milestone 6.3). */
@Database(entities = [OutgoingFile::class], version = 1, exportSchema = true)
abstract class TransferDatabase : RoomDatabase() {
    abstract fun outgoing(): OutgoingFileDao

    companion object {
        const val NAME = "transfers.db"
    }
}
