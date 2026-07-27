package com.gradethread.app.home

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.activationDataStore by preferencesDataStore(name = "activation_checklist")

/**
 * US-1370 AC2 / US-647: persistence for the activation checklist.
 *
 * Only the DISMISSAL is stored — the three step states are derived live (an item
 * exists in Room, eBay reports a connection, the OS reports notifications
 * enabled), so they can never go stale against reality.
 *
 * The dismissal itself has to persist rather than live in memory: a checklist
 * that returns on every cold start after being dismissed is the definition of
 * nagging. The rules that consume this are in [ActivationState].
 */
class ActivationChecklistStore(private val context: Context) {

    val dismissed: Flow<Boolean> =
        context.activationDataStore.data.map { it[DISMISSED_KEY] ?: false }

    suspend fun dismiss() {
        context.activationDataStore.edit { it[DISMISSED_KEY] = true }
    }

    private companion object {
        val DISMISSED_KEY = booleanPreferencesKey("dismissed")
    }
}
