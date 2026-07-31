package com.gradethread.app.onboarding

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

private val Context.onboardingStore by preferencesDataStore(name = "onboarding")

/**
 * US-1384 AC3 (iOS `OnboardingState`): the first-run flags.
 *
 * Every key carries a `_v1` suffix. A future redesign that wants to show
 * onboarding again to existing users bumps the suffix rather than shipping a
 * migration, which is the only version of this that stays simple.
 */
@Singleton
class OnboardingStore @Inject constructor(
    @ApplicationContext private val context: Context,
) {

    val completed: Flow<Boolean> =
        context.onboardingStore.data.map { it[COMPLETED_KEY] ?: false }

    val useCase: Flow<OnboardingUseCase?> =
        context.onboardingStore.data.map { OnboardingUseCase.fromWire(it[USE_CASE_KEY]) }

    suspend fun completedNow(): Boolean = completed.first()

    /** Whether the notification dialog has already been put up once. */
    suspend fun notificationsAsked(): Boolean =
        context.onboardingStore.data.map { it[ASKED_NOTIFICATIONS_KEY] ?: false }.first()

    suspend fun markNotificationsAsked() {
        context.onboardingStore.edit { it[ASKED_NOTIFICATIONS_KEY] = true }
    }

    /**
     * Finish onboarding.
     *
     * The pending-first-action flag is set even when the use case is null
     * (US-1178): someone who skipped still deserves a nudge toward adding an
     * item rather than a bare dashboard with nothing on it.
     */
    suspend fun complete(useCase: OnboardingUseCase?) {
        context.onboardingStore.edit { prefs ->
            prefs[COMPLETED_KEY] = true
            if (useCase == null) prefs.remove(USE_CASE_KEY) else prefs[USE_CASE_KEY] = useCase.wire
            prefs[PENDING_FIRST_ACTION_KEY] = true
        }
    }

    /**
     * Read and clear the one-shot first action.
     *
     * Cleared in the SAME edit as the read, so the two paths that can trigger
     * routing (finishing the flow with the shell already up, and the shell
     * mounting later) cannot both fire it.
     */
    suspend fun takeFirstAction(): OnboardingUseCase? {
        var route: OnboardingUseCase? = null
        context.onboardingStore.edit { prefs ->
            if (prefs[PENDING_FIRST_ACTION_KEY] == true) {
                route = OnboardingUseCase.fromWire(prefs[USE_CASE_KEY])
                prefs[PENDING_FIRST_ACTION_KEY] = false
            }
        }
        return route
    }

    /** Sign-out: the next account gets its own first run. */
    suspend fun clear() {
        context.onboardingStore.edit { it.clear() }
    }

    private companion object {
        val COMPLETED_KEY = booleanPreferencesKey("completed_v1")
        val USE_CASE_KEY = stringPreferencesKey("use_case_v1")
        val PENDING_FIRST_ACTION_KEY = booleanPreferencesKey("pending_first_action_v1")
        val ASKED_NOTIFICATIONS_KEY = booleanPreferencesKey("asked_notifications_v1")
    }
}
