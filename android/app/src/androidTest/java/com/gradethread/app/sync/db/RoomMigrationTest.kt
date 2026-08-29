package com.gradethread.app.sync.db

import androidx.room.testing.MigrationTestHelper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * US-2502: do the Room migrations actually run against a real database?
 *
 * Nothing else in this project answers that. A migration is a string of SQL
 * executed on a device; it type-checks whatever it says, the unit tests never
 * touch it, and `GradeThreadDb.build()` deliberately refuses
 * `fallbackToDestructiveMigration` -- so a wrong `ALTER` is not a degraded
 * experience, it is a crash on launch for every seller who already had the app,
 * and it ships green.
 *
 * [MigrationTestHelper] creates a database at the OLD version from the exported
 * schema JSON, runs the real migration objects forward, and then validates the
 * resulting schema against the NEW version's JSON. `validateDroppedTables` is on:
 * a migration that recreates a table and forgets to drop the temporary copy
 * passes every other check.
 *
 * Starts at 5, not 1: schemas 3.json and 4.json were never committed, and a
 * schema that was not exported at the time cannot be recovered afterwards.
 * `android/scripts/check-room-schemas.mjs` records that gap and fails the build
 * if any FUTURE version repeats it -- which is the part that was actually
 * fixable.
 */
@RunWith(AndroidJUnit4::class)
class RoomMigrationTest {

    @get:Rule
    val helper = MigrationTestHelper(
        InstrumentationRegistry.getInstrumentation(),
        GradeThreadDb::class.java,
    )

    /** The oldest version whose schema JSON exists. See the class comment. */
    private val oldestTestable = 5

    @Test
    fun migratesFromOldestExportedSchemaToCurrent() {
        helper.createDatabase(DB_NAME, oldestTestable).close()
        helper.runMigrationsAndValidate(
            DB_NAME,
            CURRENT_VERSION,
            true,
            *DatabaseProvider.ALL_MIGRATIONS,
        )
    }

    /**
     * Each step on its own, so a failure names the migration rather than the
     * range. A 5 -> 7 failure tells you something between two versions is wrong;
     * a 6 -> 7 failure tells you which ALTER to look at.
     */
    @Test
    fun eachMigrationStepValidatesOnItsOwn() {
        for (from in oldestTestable until CURRENT_VERSION) {
            val name = "$DB_NAME-step-$from"
            helper.createDatabase(name, from).close()
            helper.runMigrationsAndValidate(name, from + 1, true, *DatabaseProvider.ALL_MIGRATIONS)
        }
    }

    /**
     * The seller's data has to survive the migration, which schema validation
     * says nothing about: a migration that drops and recreates a table passes
     * every structural check and loses every row.
     */
    @Test
    fun rowsSurviveTheMigration() {
        val name = "$DB_NAME-data"
        helper.createDatabase(name, oldestTestable).use { db ->
            db.execSQL(
                // Every NOT NULL column at v5, or the insert fails for a reason
                // that has nothing to do with the migration under test.
                "INSERT INTO inventory_items " +
                    "(id, userId, title, status, createdAt, updatedAt, hasLocalChanges) " +
                    "VALUES ('mig-test-1', 'user-1', 'Test jacket', 'sourced', 0, 0, 0)",
            )
        }
        helper.runMigrationsAndValidate(name, CURRENT_VERSION, true, *DatabaseProvider.ALL_MIGRATIONS)
            .use { db ->
                db.query("SELECT title FROM inventory_items WHERE id = 'mig-test-1'").use { c ->
                    check(c.moveToFirst()) { "the row was lost by a migration" }
                    check(c.getString(0) == "Test jacket") { "the row's data was rewritten" }
                }
            }
    }

    private companion object {
        const val DB_NAME = "migration-test"

        /**
         * The version the app declares, so bumping it without adding a
         * migration fails HERE instead of at the next launch on a real phone.
         *
         * ⚠ THIS USED TO READ THE ANNOTATION AND COULD NEVER HAVE WORKED.
         * `GradeThreadDb::class.java.getAnnotation(Database::class.java)` is
         * null on a device - `androidx.room.Database` is CLASS-retention, not
         * RUNTIME - so the `!!` threw an NPE inside this companion. Every case
         * in this class failed on class initialization, which reported as
         * `ExceptionInInitializerError` once and `NoClassDefFoundError` twice,
         * and the class had therefore never actually tested a migration.
         *
         * The intent survives: [GRADETHREAD_DB_VERSION] is the const the
         * `@Database` annotation itself is declared with, so there is still one
         * number and the two cannot drift.
         */
        val CURRENT_VERSION: Int = GRADETHREAD_DB_VERSION
    }
}
