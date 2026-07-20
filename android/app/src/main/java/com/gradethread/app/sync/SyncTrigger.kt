package com.gradethread.app.sync

import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.gradethread.app.platform.telemetry.Telemetry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

/**
 * US-2151: what actually kicks sync off.
 *
 * Three triggers, per the acceptance criteria: sign-in, app foreground, and
 * an explicit pull-to-refresh. All funnel through [SyncService.pull], which
 * is single-flight, so overlapping triggers coalesce rather than racing.
 */
@Singleton
class SyncTrigger @Inject constructor(private val service: SyncService) {

    // Application-scoped: a pull started on foreground must not die because
    // the screen that happened to be visible went away mid-flight.
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Register the foreground trigger. Call once, from Application.onCreate. */
    fun observeForeground() {
        ProcessLifecycleOwner.get().lifecycle.addObserver(
            object : DefaultLifecycleObserver {
                override fun onStart(owner: LifecycleOwner) {
                    // Fires on cold start AND on every return from background,
                    // which is exactly when local data is most likely stale.
                    pullInBackground(reason = "foreground")
                }
            },
        )
    }

    /** Sign-in: the first pull that populates an empty database. */
    fun onSignedIn() = pullInBackground(reason = "sign_in")

    /**
     * Explicit refresh. Suspends so the caller can drive a spinner and
     * surface failures.
     */
    suspend fun refresh(): SyncCoordinator.Outcome? = runPull(reason = "manual")

    private fun pullInBackground(reason: String) {
        scope.launch { runCatching { runPull(reason) } }
    }

    private suspend fun runPull(reason: String): SyncCoordinator.Outcome? {
        val outcome = service.pull()
        if (outcome == null) {
            // Signed out — not an error, just nothing to scope a pull to.
            return null
        }
        Telemetry.event(
            "android_sync_pull",
            mapOf(
                "reason" to reason,
                "rows" to outcome.rowsApplied,
                "failed_tables" to outcome.failures.size,
                "has_more" to outcome.hasMore,
            ),
        )
        outcome.failures.forEach { failure ->
            Telemetry.breadcrumb(
                "Sync pull failed for ${failure.table.key}: ${failure.error?.message}",
                "sync",
            )
        }
        return outcome
    }
}
