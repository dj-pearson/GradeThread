package com.gradethread.app.sync

import android.content.Context
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.gradethread.app.auth.AuthRepository
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.platform.workspace.WorkspaceScope
import dagger.hilt.android.qualifiers.ApplicationContext
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import javax.inject.Inject
import javax.inject.Singleton

/**
 * US-2367: the thing that actually turns realtime on.
 *
 * [RealtimeService] has been complete since US-1321 — owner-scoped channel,
 * off-main decode, catch-up on every re-subscribe — and had NO caller anywhere
 * in the app. So the client had no live updates at all, and nobody noticed,
 * because the failure mode of missing realtime is simply "the list is a bit
 * stale", which looks identical to a slow sync.
 *
 * Every decision lives in [RealtimeLifecycle] so it is testable; this is the
 * plumbing around it.
 */
@Singleton
class RealtimeCoordinator @Inject constructor(
    @ApplicationContext private val context: Context,
    private val client: SupabaseClient,
    private val realtime: RealtimeService,
) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Serializes start/pause/rehome — the socket is one shared resource. */
    private val gate = Mutex()

    private val foreground = MutableStateFlow(false)
    private val signedIn = MutableStateFlow(false)

    /** Call once, from Application.onCreate. */
    fun start(auth: AuthRepository) {
        ProcessLifecycleOwner.get().lifecycle.addObserver(
            object : DefaultLifecycleObserver {
                override fun onStart(owner: LifecycleOwner) {
                    foreground.value = true
                    reconcile()
                }

                // Background: the socket costs battery and data for updates
                // nobody is looking at, and the foreground catch-up will
                // recover whatever was missed.
                override fun onStop(owner: LifecycleOwner) {
                    foreground.value = false
                    reconcile()
                }
            },
        )
        scope.launch {
            auth.phase.collect { phase ->
                signedIn.value = phase is AuthRepository.Phase.SignedIn
                reconcile()
            }
        }
        scope.launch {
            // ONLY the involuntary path. A deliberate switch is driven by
            // WorkspaceSwitcher, which re-homes AFTER the cache wipe so the
            // catch-up pull is scoped to the new tenant; re-homing here too
            // would fire once too early and once too often.
            WorkspaceScope.events.collect { event ->
                if (event is WorkspaceScope.Event.AccessRevoked) rehome()
            }
        }
    }

    private fun reconcile() {
        scope.launch {
            gate.withLock {
                val action = RealtimeLifecycle.decide(
                    signedIn = signedIn.value,
                    foreground = foreground.value,
                    enabled = RealtimeService.isEnabled(context),
                    phase = realtime.phase.value,
                )
                when (action) {
                    RealtimeLifecycle.Action.START -> ownerId()?.let { owner ->
                        runCatching { realtime.start(owner) }.onFailure {
                            Telemetry.breadcrumb("realtime start failed: ${it.message}", "sync")
                        }
                    }

                    RealtimeLifecycle.Action.PAUSE ->
                        runCatching { realtime.pause() }.onFailure {
                            Telemetry.breadcrumb("realtime pause failed: ${it.message}", "sync")
                        }

                    RealtimeLifecycle.Action.NONE -> Unit
                }
            }
        }
    }

    /** US-1388: move the channel onto the newly-active workspace. */
    suspend fun rehome() {
        gate.withLock {
            if (!RealtimeLifecycle.shouldRehome(realtime.phase.value)) return
            val owner = ownerId() ?: return
            runCatching { realtime.rehome(owner) }.onFailure {
                Telemetry.breadcrumb("realtime rehome failed: ${it.message}", "sync")
            }
        }
    }

    /** The active workspace, else the signed-in user — the standard scoping. */
    private fun ownerId(): String? =
        client.auth.currentUserOrNull()?.id?.let { WorkspaceScope.tenantOwnerId(it) }
}
