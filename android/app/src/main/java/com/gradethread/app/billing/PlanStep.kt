package com.gradethread.app.billing

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.planStepDataStore by preferencesDataStore(name = "plan_step")

/**
 * US-1367 AC2: the one-time plan step after signing up (iOS US-804).
 *
 * Recorded PER ACCOUNT, not per install. Two people share a tablet more often
 * than anyone plans for, and a device-wide flag would mean the second one never
 * sees the step at all.
 */
object PlanStep {

    /**
     * Show the step exactly once, and only to someone on the free plan.
     *
     * The plan check is not redundant with the seen-list: a user who subscribed
     * on the web and then installed the app has never seen the step and does not
     * need to. Selling someone a plan they already pay for is the failure mode
     * worth designing around.
     */
    fun shouldShow(userId: String?, seen: Set<String>, currentPlan: PlanTier?): Boolean {
        if (userId.isNullOrBlank()) return false
        if (currentPlan != null) return false
        return userId !in seen
    }
}

class PlanStepStore(private val context: Context) {

    /** Accounts that have already been through the step. */
    val seen: Flow<Set<String>> =
        context.planStepDataStore.data.map { it[SEEN_KEY] ?: emptySet() }

    /**
     * Mark the step done.
     *
     * Called when the seller picks a plan AND when they continue on free —
     * "continue on free" is a decision, and asking again tomorrow would treat it
     * as an accident.
     */
    suspend fun markSeen(userId: String) {
        context.planStepDataStore.edit { prefs ->
            prefs[SEEN_KEY] = (prefs[SEEN_KEY] ?: emptySet()) + userId
        }
    }

    private companion object {
        val SEEN_KEY = stringSetPreferencesKey("plan_step_seen_user_ids")
    }
}
