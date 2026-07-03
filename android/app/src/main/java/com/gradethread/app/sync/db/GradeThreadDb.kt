package com.gradethread.app.sync.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * US-1316: the offline cache database. Version 1 is the Android baseline;
 * future entity changes bump the version with explicit Room migrations.
 *
 * SEPARATE from the Room version: [WATERMARK_SCHEMA_VERSION] — bumping it
 * signals the sync engine's persisted watermarks describe an older PULL
 * shape, so the next sync must reset cursors and full-backfill (the iOS
 * watermark-schema rule). Room migrations preserve rows; the watermark
 * version decides whether those rows are COMPLETE.
 */
@Database(
    entities = [
        InventoryItemEntity::class,
        ItemPhotoEntity::class,
        SaleEntity::class,
        ExpenseEntity::class,
        ListingEntity::class,
        SourceEntity::class,
        PendingMutationEntity::class,
    ],
    version = 1,
    exportSchema = true,
)
abstract class GradeThreadDb : RoomDatabase() {
    abstract fun items(): ItemDao
    abstract fun photos(): PhotoDao
    abstract fun sales(): SaleDao
    abstract fun expenses(): ExpenseDao
    abstract fun listings(): ListingDao
    abstract fun sources(): SourceDao
    abstract fun pendingMutations(): PendingMutationDao

    companion object {
        const val DB_NAME = "gradethread.db"

        /** Bump when the pull shape changes → one-time full backfill. */
        const val WATERMARK_SCHEMA_VERSION = 1
    }
}

/**
 * US-1316: database opening with the iOS ModelStoreProvider recovery chain:
 *
 *  1. normal open;
 *  2. DESTRUCTIVE RECOVERY (one-time): a corrupt store deletes + recreates —
 *     the cache is a mirror; the server refills it (a one-time "local data
 *     was reset" notice surfaces via [outcome]);
 *  3. IN-MEMORY FALLBACK: even recovery failed — run ephemeral rather than
 *     crash. Only a broken SCHEMA is allowed to be fatal, never data.
 */
object DatabaseProvider {

    enum class Outcome {
        /** Opened normally. */ NORMAL,

        /** The store was corrupt; it was deleted and recreated. */ RESET,

        /** Persistent storage unusable; running in-memory this session. */ EPHEMERAL,
    }

    private val outcomeFlow = MutableStateFlow<Outcome?>(null)

    /** One-time notice source for the "local data was reset" banner. */
    val outcome: StateFlow<Outcome?> = outcomeFlow

    fun open(context: Context, dbName: String = GradeThreadDb.DB_NAME): GradeThreadDb {
        // 1. Normal open. Room defers real file access, so probe with a query.
        runCatching {
            val db = build(context, dbName)
            db.openHelper.readableDatabase // force the open NOW
            outcomeFlow.value = Outcome.NORMAL
            return db
        }

        // 2. One-time destructive recovery: delete the corrupt store + retry.
        runCatching {
            context.deleteDatabase(dbName)
            val db = build(context, dbName)
            db.openHelper.readableDatabase
            outcomeFlow.value = Outcome.RESET
            return db
        }

        // 3. Ephemeral fallback — never crash on data.
        outcomeFlow.value = Outcome.EPHEMERAL
        return Room.inMemoryDatabaseBuilder(context, GradeThreadDb::class.java).build()
    }

    private fun build(context: Context, dbName: String): GradeThreadDb =
        Room.databaseBuilder(context, GradeThreadDb::class.java, dbName)
            // v1 has no prior migrations; future versions add explicit ones.
            .build()
}
