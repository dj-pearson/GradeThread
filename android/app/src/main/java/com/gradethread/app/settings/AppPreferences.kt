package com.gradethread.app.settings

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.settingsDataStore by preferencesDataStore(name = "app_preferences")

/**
 * US-1383 AC2 (iOS `AppPreferences`): the display/behaviour preferences the
 * settings screen owns, persisted to DataStore.
 *
 * Analytics opt-out deliberately does NOT live here — it is owned by
 * [com.gradethread.app.platform.telemetry.Telemetry], which has to read it at
 * process start before any DI graph exists, and duplicating the key would let
 * the two disagree about whether the user opted out. The same goes for the app
 * lock mode ([com.gradethread.app.platform.applock.AppLock]).
 */
class AppPreferences(private val context: Context) {

    /**
     * Show cost basis and profit figures on list rows.
     *
     * Off by default: sellers source in public — thrift stores, estate sales —
     * and the iOS surface learned that having purchase prices on screen by
     * default is the kind of thing people notice over your shoulder.
     */
    val showCostOnRows: Flow<Boolean> =
        context.settingsDataStore.data.map { it[SHOW_COST_KEY] ?: false }

    /** Confirm before a bulk action that touches more than a handful of items. */
    val confirmBulkActions: Flow<Boolean> =
        context.settingsDataStore.data.map { it[CONFIRM_BULK_KEY] ?: true }

    /** Haptic feedback on section switches and primary actions. */
    val hapticsEnabled: Flow<Boolean> =
        context.settingsDataStore.data.map { it[HAPTICS_KEY] ?: true }

    suspend fun setShowCostOnRows(enabled: Boolean) = set(SHOW_COST_KEY, enabled)

    suspend fun setConfirmBulkActions(enabled: Boolean) = set(CONFIRM_BULK_KEY, enabled)

    suspend fun setHapticsEnabled(enabled: Boolean) = set(HAPTICS_KEY, enabled)

    private suspend fun set(
        key: androidx.datastore.preferences.core.Preferences.Key<Boolean>,
        value: Boolean,
    ) {
        context.settingsDataStore.edit { it[key] = value }
    }

    private companion object {
        val SHOW_COST_KEY = booleanPreferencesKey("show_cost_on_rows")
        val CONFIRM_BULK_KEY = booleanPreferencesKey("confirm_bulk_actions")
        val HAPTICS_KEY = booleanPreferencesKey("haptics_enabled")
    }
}
