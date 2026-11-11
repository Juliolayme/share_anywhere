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

/**
 * Receive progress for one file (docs/TRANSFER_PROTOCOL.md §4): the completed-block bitmap, persisted after each block
 * is written and verified and before its ACK, keyed by the transfer capability's hash and the transfer id, plus the
 * document the bytes are written to.
 */
@Entity(tableName = "incoming_progress")
data class IncomingProgress(
    @androidx.room.PrimaryKey val key: String,
    @ColumnInfo(name = "session_id") val sessionId: String,
    @ColumnInfo(name = "transfer_id") val transferId: String,
    val name: String,
    val size: Long,
    @ColumnInfo(name = "block_size") val blockSize: Int,
    val bitmap: ByteArray,
    @ColumnInfo(name = "document_uri") val documentUri: String,
    val verified: Boolean,
    @ColumnInfo(name = "updated_at") val updatedAt: Long
) {
    override fun equals(other: Any?) =
        other is IncomingProgress && other.key == key && other.updatedAt == updatedAt && other.bitmap.contentEquals(bitmap)

    override fun hashCode() = key.hashCode()
}

/** Where a session's files are saved: the folder (SAF tree) the receiver chose on RX-5b. */
@Entity(tableName = "save_targets")
data class SaveTarget(
    @androidx.room.PrimaryKey @ColumnInfo(name = "session_id") val sessionId: String,
    @ColumnInfo(name = "tree_uri") val treeUri: String,
    val label: String,
    @ColumnInfo(name = "created_at") val createdAt: Long
)

@Dao
interface IncomingDao {
    @Query("SELECT * FROM incoming_progress WHERE `key` = :key")
    suspend fun get(key: String): IncomingProgress?

    @androidx.room.Upsert
    suspend fun put(p: IncomingProgress)

    @Query("DELETE FROM incoming_progress WHERE `key` = :key")
    suspend fun remove(key: String)

    @Query("DELETE FROM incoming_progress WHERE session_id = :sessionId")
    suspend fun removeSession(sessionId: String)

    @Query("DELETE FROM incoming_progress WHERE updated_at < :cutoff")
    suspend fun removeOlderThan(cutoff: Long): Int

    @Query("SELECT * FROM save_targets WHERE session_id = :sessionId")
    suspend fun target(sessionId: String): SaveTarget?

    @androidx.room.Upsert
    suspend fun putTarget(t: SaveTarget)

    @Query("DELETE FROM save_targets WHERE created_at < :cutoff")
    suspend fun removeTargetsOlderThan(cutoff: Long): Int
}

/** Transfer state kept on the device: picked files (sender), receive progress and save folders (receiver). */
@Database(entities = [OutgoingFile::class, IncomingProgress::class, SaveTarget::class], version = 2, exportSchema = true)
abstract class TransferDatabase : RoomDatabase() {
    abstract fun outgoing(): OutgoingFileDao

    abstract fun incoming(): IncomingDao

    companion object {
        const val NAME = "transfers.db"

        /** 6.2 → 6.3: receive progress and save folders. */
        val MIGRATION_1_2 =
            object : androidx.room.migration.Migration(1, 2) {
                override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                    db.execSQL(
                        "CREATE TABLE IF NOT EXISTS `incoming_progress` (`key` TEXT NOT NULL, `session_id` TEXT NOT NULL, " +
                            "`transfer_id` TEXT NOT NULL, `name` TEXT NOT NULL, `size` INTEGER NOT NULL, `block_size` INTEGER NOT NULL, " +
                            "`bitmap` BLOB NOT NULL, `document_uri` TEXT NOT NULL, `verified` INTEGER NOT NULL, " +
                            "`updated_at` INTEGER NOT NULL, " +
                            "PRIMARY KEY(`key`))"
                    )
                    db.execSQL(
                        "CREATE TABLE IF NOT EXISTS `save_targets` (`session_id` TEXT NOT NULL, `tree_uri` TEXT NOT NULL, " +
                            "`label` TEXT NOT NULL, `created_at` INTEGER NOT NULL, PRIMARY KEY(`session_id`))"
                    )
                }
            }
    }
}
