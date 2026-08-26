package com.gradethread.app.sync

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.gradethread.app.sync.db.GradeThreadDb
import kotlinx.coroutines.flow.first

private val Context.syncDataStore by preferencesDataStore(name = "sync_watermarks")

/**
 * US-1317: per-table delta cursors (iOS SyncWatermark, US-633). A cursor is
 * the max `updated_at` (ISO-8601, lexically ordered) the pull has SAFELY
 * consumed — see [SyncPull.safeCursor] for why "safely" matters.
 *
 * Contracts carried from iOS:
 *  - advance is MONOTONIC (a late-returning stale pull can't rewind);
 *  - [resetAll] runs BEFORE the row wipe on sign-out (the ordering rule);
 *  - a bumped [GradeThreadDb.WATERMARK_SCHEMA_VERSION] means persisted
 *    cursors describe an older pull shape → reset + one-time full backfill.
 */
class SyncWatermark(private val context: Context) {

    enum class Table(val key: String) {
        ITEMS("items"),
        PHOTOS("photos"),
        SALES("sales"),
        EXPENSES("expenses"),
        LISTINGS("listings"),
        SOURCES("sources"),

        /** US-2886: the "Sourced by" roster. */
        SOURCERS("sourcers"),

        /** US-1365: eBay payouts, the deposit side of reconciliation. */
        PAYOUTS("payouts"),
    }

    private fun cursorKey(table: Table) = stringPreferencesKey("cursor.${table.key}")

    suspend fun cursor(table: Table): String? = context.syncDataStore.data.first()[cursorKey(table)]

    /** Monotonic: only moves forward (lexical ISO compare). */
    suspend fun advance(table: Table, candidate: String) {
        context.syncDataStore.edit { prefs ->
            val current = prefs[cursorKey(table)]
            if (current == null || candidate > current) {
                prefs[cursorKey(table)] = candidate
            }
        }
    }

    /** Sign-out / workspace-switch: cursors reset BEFORE rows are wiped. */
    suspend fun resetAll() {
        context.syncDataStore.edit { prefs ->
            Table.entries.forEach { prefs.remove(cursorKey(it)) }
        }
    }

    // ── Watermark schema version (US-1316 companion) ─────────────────────────

    private val schemaKey = intPreferencesKey("watermark_schema_version")

    /** Pure decision: do persisted cursors predate the current pull shape? */
    fun needsFullBackfill(lastSeen: Int?, current: Int = GradeThreadDb.WATERMARK_SCHEMA_VERSION): Boolean =
        lastSeen == null || lastSeen < current

    suspend fun lastSeenSchemaVersion(): Int? = context.syncDataStore.data.first()[schemaKey]

    /** Reset cursors + record the current shape — the one-time backfill gate. */
    suspend fun migrateToCurrentSchema() {
        resetAll()
        context.syncDataStore.edit { it[schemaKey] = GradeThreadDb.WATERMARK_SCHEMA_VERSION }
    }
}
