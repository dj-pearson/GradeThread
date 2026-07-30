package com.gradethread.app.marketplaces.reconciliation

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.reconcileDataStore by preferencesDataStore(name = "reconcile_badge")

/**
 * US-1356: when the shell-wide orphan banner is visible.
 *
 * Pure, separate from [ReconcileBadgeStore] (which needs a Context for
 * DataStore), so the snooze rules are unit-testable without an Android runtime —
 * the same split the activation checklist uses.
 */
data class ReconcileBadgeState(
    val count: OrphanCount = OrphanCount(),
    /** Epoch millis the snooze runs until; 0 = never snoozed. */
    val snoozedUntilMs: Long = 0,
    /** The count at the moment of the snooze. */
    val snoozeBaseline: Int = 0,
) {

    /**
     * Whether the banner is hidden right now.
     *
     * Snoozed means BOTH inside the window AND no new work since. New orphans
     * beyond the baseline re-surface it: the seller dismissed the pile they had
     * seen, not every pile they will ever have.
     */
    fun isSnoozed(nowMs: Long): Boolean =
        nowMs < snoozedUntilMs && count.value <= snoozeBaseline

    fun visible(nowMs: Long): Boolean = !count.isEmpty && !isSnoozed(nowMs)

    companion object {
        /** How long a dismissal holds. */
        const val SNOOZE_WINDOW_MS = 24L * 60 * 60 * 1000
    }
}

/**
 * Persistence + refresh for the banner.
 *
 * Count-only and best-effort by design: a failed refresh keeps the last known
 * count rather than flickering the banner away. A network error is not "you
 * reconciled everything".
 */
class ReconcileBadgeStore(
    private val context: Context,
    private val service: ReconciliationService,
    private val now: () -> Long = System::currentTimeMillis,
) {

    val snoozedUntil: Flow<Long> =
        context.reconcileDataStore.data.map { it[SNOOZE_UNTIL_KEY] ?: 0L }

    val snoozeBaseline: Flow<Int> =
        context.reconcileDataStore.data.map { it[SNOOZE_BASELINE_KEY] ?: 0 }

    /** @return the fresh count, or null when the read failed (keep the old one). */
    suspend fun refresh(): OrphanCount? = runCatching { service.countOrphans() }.getOrNull()

    suspend fun snooze(count: OrphanCount) {
        context.reconcileDataStore.edit {
            it[SNOOZE_UNTIL_KEY] = now() + ReconcileBadgeState.SNOOZE_WINDOW_MS
            it[SNOOZE_BASELINE_KEY] = count.value
        }
    }

    private companion object {
        val SNOOZE_UNTIL_KEY = longPreferencesKey("snoozed_until_ms")
        val SNOOZE_BASELINE_KEY = intPreferencesKey("snooze_baseline")
    }
}
