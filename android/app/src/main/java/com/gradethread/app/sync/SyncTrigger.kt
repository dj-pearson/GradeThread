package com.gradethread.app.sync

import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.gradethread.app.auth.AuthRepository
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
 *
 * Each of those triggers also DRAINS the mutation queue ([MutationReplayer]).
 * The order is deliberate — flush before pull:
 *
 *  - flushing first means a locally-created row reaches the server BEFORE the
 *    pull that would otherwise not find it. Pull-then-flush leaves a window in
 *    which the server's view of an item is older than the device's;
 *  - it is also the ordering [DeleteReconciler] will need when it finally gets a
 *    caller (it has none today — see the story filed for that): reconciling
 *    against a half-flushed queue would prune rows the server has simply not
 *    been told about yet.
 *
 * A flush failure never blocks the pull: queued rows are retried by design, and
 * refusing to refresh because an unrelated edit can't send would be a strictly
 * worse outcome for the seller.
 */
@Singleton
class SyncTrigger @Inject constructor(
    private val service: SyncService,
    private val replayer: MutationReplayer,
    @dagger.hilt.android.qualifiers.ApplicationContext
    private val context: android.content.Context,
    private val db: com.gradethread.app.sync.db.GradeThreadDb,
) {

    // Application-scoped: a pull started on foreground must not die because
    // the screen that happened to be visible went away mid-flight.
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /**
     * Register the reconnect trigger. Call once, from Application.onCreate.
     *
     * Foreground alone is not enough for the queue: the case the offline queue
     * exists FOR is a seller who keeps working while the signal drops and comes
     * back — the app never left the foreground, so no foreground event ever
     * fires, and without this the flush waits for a backgrounding that may be
     * hours away.
     *
     * Coalesced through [ConnectivityDebouncer] because walking between Wi-Fi
     * and cell flaps `onAvailable` several times a second, and each flap would
     * otherwise kick a full flush+pull (US-997).
     */
    fun observeConnectivity(monitor: ConnectivityMonitor) {
        val debouncer = ConnectivityDebouncer(scope) { runCatching { runPull("reconnect") } }
        monitor.start()
        scope.launch {
            // Drop the replayed current value: a cold start that is already
            // online would otherwise fire a third pull on top of
            // foreground + sign-in. Only a TRANSITION to online is news.
            var wasOnline = monitor.online.value
            monitor.online.collect { online ->
                if (online && !wasOnline) debouncer.trigger()
                wasOnline = online
            }
        }
    }

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

    /** The user whose sign-in we've already pulled for. */
    private var pulledForUserId: String? = null

    /**
     * Sign-in: the first pull that populates an empty database.
     *
     * Guarded on the user id changing rather than firing on every emission.
     * [AuthRepository.phase] is a StateFlow, so a fresh collector immediately
     * receives the CURRENT phase — without this guard, every process start
     * would fire a sign-in pull on top of the foreground one. Single-flight
     * would coalesce them, but a switch to a different account must still
     * pull, and only an id comparison distinguishes the two.
     */
    fun observeSignIn(auth: AuthRepository) {
        scope.launch {
            auth.phase.collect { phase ->
                when (phase) {
                    is AuthRepository.Phase.SignedIn ->
                        if (pulledForUserId != phase.userId) {
                            pulledForUserId = phase.userId
                            pullInBackground(reason = "sign_in")
                        }
                    // Clear on sign-out so signing back in as the same user
                    // still pulls — the local database may have been wiped.
                    is AuthRepository.Phase.SignedOut -> pulledForUserId = null
                    AuthRepository.Phase.Loading -> Unit
                }
            }
        }
    }

    /**
     * Explicit refresh. Suspends so the caller can drive a spinner and
     * surface failures.
     */
    suspend fun refresh(reason: String = "manual"): SyncCoordinator.Outcome? = runPull(reason)

    private fun pullInBackground(reason: String) {
        scope.launch { runCatching { runPull(reason) } }
    }

    private suspend fun runPull(reason: String): SyncCoordinator.Outcome? {
        flushQueue(reason)
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
        // US-1380: the home-screen widget's numbers come from the local mirror,
        // so this is the only moment they can have changed. Wrapped, because a
        // widget redraw failing must never surface as a failed sync.
        runCatching {
            com.gradethread.app.widget.WidgetPublisher.publish(
                context = context,
                db = db,
                isSignedIn = true,
                nowMs = System.currentTimeMillis(),
            )
        }.onFailure { Telemetry.breadcrumb("widget publish failed: ${it.message}", "widget") }
        return outcome
    }

    /**
     * Replay whatever the queue is holding.
     *
     * Deliberately swallows: [MutationReplayer.replay] already routes per-row
     * failures through the queue's retry/stuck bookkeeping, so anything
     * reaching here is a whole-drain failure (signed out, database unavailable)
     * that the next trigger retries anyway. Letting it propagate would abort
     * the pull, which is the one part of this that still works offline-to-online.
     */
    private suspend fun flushQueue(reason: String) {
        val result = runCatching { replayer.replay() }
            .onFailure { error ->
                Telemetry.breadcrumb("Mutation flush failed: ${error.message}", "sync")
            }
            .getOrNull()
            ?: return
        // Only report a drain that actually did something — a no-op flush on
        // every foreground would drown the useful signal.
        if (result.succeeded == 0 && result.markedStuck == 0 && result.transientFailures == 0) return
        Telemetry.event(
            "android_mutation_flush",
            mapOf(
                "reason" to reason,
                "succeeded" to result.succeeded,
                "transient" to result.transientFailures,
                "stuck" to result.markedStuck,
                "deferred" to result.deferred,
                "skipped_stuck" to result.skippedStuck,
            ),
        )
    }
}
