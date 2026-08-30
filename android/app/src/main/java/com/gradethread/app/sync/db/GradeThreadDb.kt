package com.gradethread.app.sync.db

import android.content.Context
import android.database.sqlite.SQLiteDatabaseCorruptException
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
/**
 * The Room schema version, as a runtime-readable constant.
 *
 * WHY THIS IS NOT JUST THE NUMBER IN THE ANNOTATION. `androidx.room.Database`
 * is CLASS-retention, so `GradeThreadDb::class.java.getAnnotation(Database::class.java)`
 * returns NULL on a device. RoomMigrationTest read the version that way and its
 * `!!` threw an NPE in the companion initializer, which surfaced as
 * `ExceptionInInitializerError` on the first case and `NoClassDefFoundError` on
 * the other two - one bug wearing three names, and no test in that class had run
 * since it was written (US-2902).
 *
 * A const keeps the property the test wanted: the version is declared once and
 * the annotation and the migration test cannot disagree about it.
 */
internal const val GRADETHREAD_DB_VERSION = 9

@Database(
    entities = [
        InventoryItemEntity::class,
        ItemPhotoEntity::class,
        SaleEntity::class,
        ExpenseEntity::class,
        ListingEntity::class,
        SourceEntity::class,
        SourcerEntity::class,
        PayoutEntity::class,
        PendingMutationEntity::class,
        CaptureDraftEntity::class,
        IntakeBatchEntity::class,
        AutolisterSessionEntity::class,
        MileageTripEntity::class,
    ],
    version = GRADETHREAD_DB_VERSION,
    exportSchema = true,
)
abstract class GradeThreadDb : RoomDatabase() {
    abstract fun items(): ItemDao
    abstract fun photos(): PhotoDao
    abstract fun sales(): SaleDao
    abstract fun expenses(): ExpenseDao
    abstract fun mileageTrips(): MileageTripDao
    abstract fun listings(): ListingDao
    abstract fun sources(): SourceDao
    abstract fun sourcers(): SourcerDao
    abstract fun payouts(): PayoutDao
    abstract fun pendingMutations(): PendingMutationDao
    abstract fun captureDrafts(): CaptureDraftDao
    abstract fun intakeBatches(): IntakeBatchDao
    abstract fun autolisterSessions(): AutolisterSessionDao

    companion object {
        const val DB_NAME = "gradethread.db"

        /**
         * Bump when the pull shape changes → one-time full backfill.
         *
         * 2 (US-2469): `item_photos.photo_role` joined the pull. Room's
         * migration adds the COLUMN, but every cached row keeps a null role
         * until it is re-fetched — and a null role is indistinguishable from
         * "this type takes no qualifier", so the canvas would label a
         * chest-measurement photo "Measurement card (not listed)" until the
         * seller happened to touch that item. The rows survive; the backfill is
         * what makes them complete.
         */
        const val WATERMARK_SCHEMA_VERSION = 2
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
        /** Opened normally. */
        NORMAL,

        /** The store was corrupt; it was deleted and recreated. */
        RESET,

        /** Persistent storage unusable; running in-memory this session. */
        EPHEMERAL,
    }

    private val outcomeFlow = MutableStateFlow<Outcome?>(null)

    /** One-time notice source for the "local data was reset" banner. */
    val outcome: StateFlow<Outcome?> = outcomeFlow

    /**
     * US-2340 AC1: the ONE production instance.
     *
     * [DatabaseModule] provides this as a Hilt `@Singleton` and its comment says
     * why - re-running the recovery probe per call site can hand two callers
     * different instances after a RESET. Three sites bypassed Hilt anyway
     * (`CaptureScreen` inside a `remember`, and `UploadWorker` twice), so the
     * guarantee lived in a comment rather than in the code.
     *
     * Memoized HERE rather than only fixed at those three, because that is
     * self-healing: a fourth caller cannot reintroduce the bug by not knowing
     * about Hilt. Keyed on the default name only - a test opening a custom
     * `dbName` gets a fresh instance, which is what
     * `corruptStore_recoversDestructivelyThenWorks` needs.
     */
    @Volatile
    private var instance: GradeThreadDb? = null

    fun open(context: Context, dbName: String = GradeThreadDb.DB_NAME): GradeThreadDb {
        if (dbName != GradeThreadDb.DB_NAME) return openUncached(context, dbName)
        instance?.let { return it }
        return synchronized(this) {
            instance ?: openUncached(context.applicationContext, dbName).also { instance = it }
        }
    }

    /**
     * Forces Room's deferred open to happen NOW, so a bad store fails here
     * rather than at the first query on some screen.
     *
     * Injectable ONLY so the recovery ladder is testable. The first version of
     * the AC3 test tried to induce a real open failure from the filesystem, and
     * a sabotage proved it worthless: reverting the fix to "delete on any
     * failure" left it green, because the open had never failed at all. A seam
     * that can force a SPECIFIC throwable is the difference between testing the
     * rule and testing nothing.
     */
    internal var probe: (GradeThreadDb) -> Unit = { it.openHelper.readableDatabase }

    /**
     * True when [error] is SQLite telling us the FILE is damaged, rather than
     * telling us it could not be opened right now.
     *
     * US-2340 AC2, and the distinction is the whole story. Step 2 below deletes
     * the seller's unsynced captures and queued mutations, and it used to run on
     * ANY step-1 throw: a locked file, low storage, or a missing migration. The
     * missing-migration case is the sharpest, because `build()` deliberately
     * does NOT use `fallbackToDestructiveMigration` - [MIGRATION_1_2]'s comment
     * says outright that destructive fallback "would silently delete their
     * unsynced captures and queued mutations". Refusing it in the builder and
     * then doing it in the catch-all is the same data loss by a longer route.
     *
     * Walks the cause chain because Room wraps the driver's exception.
     */
    private fun isCorruption(error: Throwable?): Boolean {
        var cause = error
        var hops = 0
        while (cause != null && hops < 8) {
            if (cause is SQLiteDatabaseCorruptException) return true
            cause = cause.cause
            hops++
        }
        return false
    }

    private fun openUncached(context: Context, dbName: String): GradeThreadDb {
        // 1. Normal open. Room defers real file access, so probe with a query.
        val first = runCatching {
            val db = build(context, dbName)
            probe(db) // force the open NOW
            outcomeFlow.value = Outcome.NORMAL
            return db
        }

        // 2. Destructive recovery, ONLY for a store SQLite says is corrupt.
        //    Anything else falls through to step 3 with the file left alone, so
        //    a transient failure costs this session and not the seller's data.
        if (isCorruption(first.exceptionOrNull())) {
            runCatching {
                context.deleteDatabase(dbName)
                val db = build(context, dbName)
                // Deliberately the REAL open, not [probe]. Recovery has to prove
                // the rebuilt store actually works; running it through a test
                // seam that just threw would prove the opposite.
                db.openHelper.readableDatabase
                outcomeFlow.value = Outcome.RESET
                return db
            }
        }

        // 3. Ephemeral fallback — never crash on data.
        outcomeFlow.value = Outcome.EPHEMERAL
        return Room.inMemoryDatabaseBuilder(context, GradeThreadDb::class.java).build()
    }

    private fun build(context: Context, dbName: String): GradeThreadDb =
        Room.databaseBuilder(context, GradeThreadDb::class.java, dbName)
            .addMigrations(*ALL_MIGRATIONS)
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

    /**
     * US-1382: the share-target intake inbox.
     *
     * Explicit, like its predecessors — a version bump with no migration is a
     * crash on launch for every device already holding a v4 file, and
     * destructive fallback would take their queued mutations with it.
     */
    internal val MIGRATION_4_5 = object : androidx.room.migration.Migration(4, 5) {
        override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS intake_batches (
                    id TEXT NOT NULL PRIMARY KEY,
                    photosJson TEXT NOT NULL,
                    createdAt INTEGER NOT NULL
                )
                """.trimIndent(),
            )
        }
    }

    /**
     * US-2469 (server migration 00587): the photo ROLE qualifier.
     *
     * Explicit, like its predecessors — a version bump with no migration is a
     * crash on launch for every device already holding a v5 file, and
     * destructive fallback would take their unsynced captures with it.
     *
     * NULL is the correct value for every existing row and stays correct: a
     * pre-00587 photo genuinely has no qualifier, and the retired types it may
     * be sitting on (`measurement_chest`, `tag_2`) still carry their own
     * meaning through [com.gradethread.app.capture.FlipdeskPhotoType.retired].
     * The server's own backfill arrives with the next full pull, which is what
     * WATERMARK_SCHEMA_VERSION = 2 forces.
     */
    internal val MIGRATION_5_6 = object : androidx.room.migration.Migration(5, 6) {
        override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE item_photos ADD COLUMN photoRole TEXT DEFAULT NULL")
        }
    }

    /**
     * US-2408: the AutoLister session survives process death.
     *
     * Explicit, like its predecessors — a version bump with no migration is a
     * crash on launch for every device already holding a v6 file, and
     * destructive fallback would take their queued mutations with it.
     */
    internal val MIGRATION_6_7 = object : androidx.room.migration.Migration(6, 7) {
        override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS autolister_sessions (
                    id TEXT NOT NULL PRIMARY KEY,
                    stateJson TEXT NOT NULL,
                    updatedAt INTEGER NOT NULL
                )
                """.trimIndent(),
            )
        }
    }

    /**
     * US-2886: the "Sourced by" roster.
     *
     * A new table, so nothing existing is rewritten and no cached row becomes
     * incomplete — which is why [WATERMARK_SCHEMA_VERSION] does NOT move. The
     * table starts with no sync cursor, so its first pull is a full backfill by
     * construction rather than by a forced one.
     */
    internal val MIGRATION_7_8 = object : androidx.room.migration.Migration(7, 8) {
        override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS sourcers (
                    id TEXT NOT NULL PRIMARY KEY,
                    userId TEXT NOT NULL,
                    name TEXT NOT NULL,
                    memberUserId TEXT,
                    archivedAt INTEGER,
                    createdAt INTEGER NOT NULL,
                    updatedAt INTEGER NOT NULL
                )
                """.trimIndent(),
            )
        }
    }

    /**
     * US-3000: mileage trips, logged on the phone.
     *
     * A new table, so nothing existing is rewritten and no cached row becomes
     * incomplete -- which is why [WATERMARK_SCHEMA_VERSION] does NOT move. The
     * table starts with no sync cursor, so its first pull is a full backfill by
     * construction rather than by a forced one.
     */
    internal val MIGRATION_8_9 = object : androidx.room.migration.Migration(8, 9) {
        override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS mileage_trips (
                    id TEXT NOT NULL PRIMARY KEY,
                    tripDate INTEGER NOT NULL,
                    miles REAL NOT NULL,
                    purpose TEXT NOT NULL,
                    startLocation TEXT,
                    endLocation TEXT,
                    roundTrip INTEGER NOT NULL,
                    sourceId TEXT,
                    createdAt INTEGER NOT NULL
                )
                """.trimIndent(),
            )
            db.execSQL(
                "CREATE INDEX IF NOT EXISTS index_mileage_trips_tripDate ON mileage_trips (tripDate)",
            )
        }
    }

    /**
     * Every migration, in order, declared ONCE.
     *
     * US-2502: [build] used to list them inline and the instrumented migration
     * test would have listed them again. Two lists means a new migration can be
     * added to the builder and forgotten in the test, and the test then passes
     * by validating a migration path the app does not take -- which is worse
     * than having no test, because it reports success.
     *
     * Declared AFTER the migrations it references: companion-object properties
     * initialize top to bottom, so moving this up would fill the array with
     * nulls and fail at the first launch, not at compile time.
     */
    internal val ALL_MIGRATIONS: Array<androidx.room.migration.Migration> = arrayOf(
        MIGRATION_1_2,
        MIGRATION_2_3,
        MIGRATION_3_4,
        MIGRATION_4_5,
        MIGRATION_5_6,
        MIGRATION_6_7,
        MIGRATION_7_8,
        MIGRATION_8_9,
    )
}
