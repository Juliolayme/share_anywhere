package app.shareanywhere.history

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Query
import androidx.room.RoomDatabase
import androidx.room.Transaction
import androidx.room.TypeConverter
import androidx.room.TypeConverters
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

@Dao
abstract class HistoryDao {
    @Query("SELECT * FROM history ORDER BY created_at DESC")
    abstract fun observeAll(): Flow<List<HistoryEntry>>

    @Query("SELECT * FROM history WHERE id = :id")
    abstract fun observe(id: String): Flow<HistoryEntry?>

    @Upsert
    abstract suspend fun upsert(entry: HistoryEntry)

    @Query("DELETE FROM history WHERE id = :id")
    abstract suspend fun delete(id: String)

    @Query("SELECT * FROM history ORDER BY created_at DESC")
    abstract suspend fun all(): List<HistoryEntry>

    @Query("SELECT id FROM history")
    abstract suspend fun ids(): List<String>

    @Query("DELETE FROM history")
    abstract suspend fun deleteAll()

    @Query("DELETE FROM history WHERE created_at <= :cutoff")
    abstract suspend fun deleteCreatedAtOrBefore(cutoff: Long): Int

    @Upsert
    abstract suspend fun markRemoved(ids: List<RemovedHistoryId>)

    @Query("SELECT COUNT(*) FROM history_removed WHERE id = :id AND removed_at > :since")
    abstract suspend fun removedSince(id: String, since: Long): Int

    @Query(
        "DELETE FROM history_removed WHERE removed_at <= :before OR id NOT IN " +
            "(SELECT id FROM history_removed ORDER BY removed_at DESC LIMIT :keep)"
    )
    abstract suspend fun pruneRemoved(before: Long, keep: Int)

    /** Adds [entry] unless the user deleted that id recently. Returns whether it was written. */
    @Transaction
    open suspend fun addUnlessRemoved(entry: HistoryEntry, removedSince: Long): Boolean {
        if (removedSince(entry.id, removedSince) > 0) return false
        upsert(entry)
        return true
    }

    @Transaction
    open suspend fun removeAndRemember(ids: List<String>, now: Long, removedBefore: Long, keep: Int) {
        markRemoved(ids.map { RemovedHistoryId(it, now) })
        for (id in ids) delete(id)
        pruneRemoved(removedBefore, keep)
    }

    @Transaction
    open suspend fun clearAndRemember(now: Long, removedBefore: Long, keep: Int) {
        markRemoved(ids().map { RemovedHistoryId(it, now) })
        deleteAll()
        pruneRemoved(removedBefore, keep)
    }
}

/** Room column converters: enums by their Web wire names, lists as JSON. */
class HistoryConverters {
    // Explicit types: KSP (Room) cannot see members the serialization compiler plugin generates.
    private val json: Json = Json { ignoreUnknownKeys = true }
    private val strings: KSerializer<List<String>> = ListSerializer(String.serializer())
    private val files: KSerializer<List<HistoryFile>> = ListSerializer(HistoryFile.serializer())

    @TypeConverter fun direction(v: Direction): String = v.wire

    @TypeConverter fun direction(v: String): Direction = Direction.entries.first { it.wire == v }

    @TypeConverter fun status(v: HistoryStatus): String = v.wire

    @TypeConverter fun status(v: String): HistoryStatus = HistoryStatus.entries.first { it.wire == v }

    @TypeConverter fun route(v: HistoryRoute?): String? = v?.wire

    @TypeConverter fun routeOf(v: String?): HistoryRoute? = HistoryRoute.entries.firstOrNull { it.wire == v }

    @TypeConverter fun peers(v: List<String>?): String? = v?.let { json.encodeToString(strings, it) }

    @TypeConverter fun peersOf(v: String?): List<String>? = v?.let { json.decodeFromString(strings, it) }

    @TypeConverter fun files(v: List<HistoryFile>?): String? = v?.let { json.encodeToString(files, it) }

    @TypeConverter fun filesOf(v: String?): List<HistoryFile>? = v?.let { json.decodeFromString(files, it) }
}

@Database(entities = [HistoryEntry::class, RemovedHistoryId::class], version = 1, exportSchema = true)
@TypeConverters(HistoryConverters::class)
abstract class HistoryDatabase : RoomDatabase() {
    abstract fun history(): HistoryDao

    companion object {
        const val NAME = "share-anywhere-history.db"
    }
}
