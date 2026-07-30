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
        PayoutEntity::class,
        PendingMutationEntity::class,
        CaptureDraftEntity::class,
    ],
    version = 4,
    exportSchema = true,
)
abstract class GradeThreadDb : RoomDatabase() {
    abstract fun items(): ItemDao
    abstract fun photos(): PhotoDao
    abstract fun sales(): SaleDao
    abstract fun expenses(): ExpenseDao
    abstract fun listings(): ListingDao
    abstract fun sources(): SourceDao
    abstract fun payouts(): PayoutDao
    abstract fun pendingMutations(): PendingMutationDao
    abstract fun captureDrafts(): CaptureDraftDao

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
            .addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4)
            .build()

    /**
     * US-1347: the eBay specifics columns.
     *
     * An EXPLICIT migration, not destructive fallback. Room refuses to open a
     * database whose schema hash it can't verify, so a version bump with no
     * migration is a crash on launch for anyone already holding a v1 file —
     * and destructive fallback would silently delete their unsynced captures
     * and queued mutations to avoid it.
     */
    internal val MIGRATION_1_2 = object : androidx.room.migration.Migration(1, 2) {
        override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE inventory_items ADD COLUMN ebayCategoryId TEXT DEFAULT NULL")
            db.execSQL("ALTER TABLE inventory_items ADD COLUMN ebayAspectsJson TEXT DEFAULT NULL")
            db.execSQL(
                "ALTER TABLE inventory_items ADD COLUMN ebayAspectSourcesJson TEXT DEFAULT NULL",
            )
        }
    }

    /**
     * US-1351: the listed quantity mirrored from eBay.
     *
     * Explicit like [MIGRATION_1_2] — a version bump with no migration is a
     * launch crash for anyone already holding a v2 file, and destructive
     * fallback would take their queued mutations with it.
     */
    internal val MIGRATION_2_3 = object : androidx.room.migration.Migration(2, 3) {
        override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE listings ADD COLUMN quantity INTEGER DEFAULT NULL")
        }
    }

    /**
     * US-1365: the payouts table + the per-sale payout amount.
     *
     * Explicit, like its predecessors — a version bump with no migration is a
     * crash on launch for every device already holding a v3 file.
     */
    internal val MIGRATION_3_4 = object : androidx.room.migration.Migration(3, 4) {
        override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE sales ADD COLUMN payoutAmount REAL DEFAULT NULL")
            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS ebay_payouts (
                    id TEXT NOT NULL PRIMARY KEY,
                    payoutId TEXT NOT NULL,
                    amountCents INTEGER,
                    currency TEXT,
                    status TEXT,
                    payoutDate INTEGER,
                    transactionCount INTEGER,
                    updatedAt INTEGER NOT NULL
                )
                """.trimIndent(),
            )
            db.execSQL(
                "CREATE UNIQUE INDEX IF NOT EXISTS index_ebay_payouts_payoutId " +
                    "ON ebay_payouts(payoutId)",
            )
            db.execSQL(
                "CREATE INDEX IF NOT EXISTS index_ebay_payouts_payoutDate " +
                    "ON ebay_payouts(payoutDate)",
            )
        }
    }
}
