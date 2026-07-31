package com.gradethread.app.sync

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

private val Context.backgroundRefreshStore by preferencesDataStore(name = "background_refresh")

/**
 * US-1379: what the seller has already been told about, and whether they want
 * background refresh at all.
 *
 * On disk rather than in memory: the whole point is comparing against what was
 * known BEFORE the process was killed, which is most of the time for a worker
 * that runs every half hour.
 */
@Singleton
class BackgroundRefreshStore @Inject constructor(
    @ApplicationContext private val context: Context,
) {

    /** Default ON — someone who installs a reseller app wants to know it sold. */
    val enabled: Flow<Boolean> =
        context.backgroundRefreshStore.data.map { it[ENABLED_KEY] ?: true }

    suspend fun setEnabled(value: Boolean) {
        context.backgroundRefreshStore.edit { it[ENABLED_KEY] = value }
    }

    /**
     * Whether a baseline has ever been written.
     *
     * Tracked separately from the id sets being empty, because those two states
     * are genuinely different: a brand-new account legitimately has no sales,
     * and treating "no baseline yet" the same as "baseline of nothing" is how
     * the first sync announces an entire back catalogue as new.
     */
    suspend fun baselineEstablished(): Boolean =
        context.backgroundRefreshStore.data.map { it[BASELINE_SET_KEY] ?: false }.first()

    suspend fun seenSaleIds(): Set<String> =
        context.backgroundRefreshStore.data.map { it[SALES_KEY] ?: emptySet() }.first()

    suspend fun seenGradedItemIds(): Set<String> =
        context.backgroundRefreshStore.data.map { it[GRADED_KEY] ?: emptySet() }.first()

    suspend fun writeBaseline(saleIds: Set<String>, gradedItemIds: Set<String>) {
        context.backgroundRefreshStore.edit {
            it[SALES_KEY] = saleIds
            it[GRADED_KEY] = gradedItemIds
            it[BASELINE_SET_KEY] = true
        }
    }

    /**
     * Sign-out: forget everything.
     *
     * The next account's first refresh must start from no baseline, or it would
     * compare their rows against the previous seller's and announce the lot.
     */
    suspend fun clear() {
        context.backgroundRefreshStore.edit {
            it.remove(SALES_KEY)
            it.remove(GRADED_KEY)
            it.remove(BASELINE_SET_KEY)
        }
    }

    private companion object {
        val ENABLED_KEY = booleanPreferencesKey("enabled")
        val SALES_KEY = stringSetPreferencesKey("seen_sale_ids")
        val GRADED_KEY = stringSetPreferencesKey("seen_graded_item_ids")
        val BASELINE_SET_KEY = booleanPreferencesKey("baseline_established")
    }
}
