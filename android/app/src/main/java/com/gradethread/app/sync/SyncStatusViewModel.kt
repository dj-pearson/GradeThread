package com.gradethread.app.sync

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.sync.db.GradeThreadDb
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import javax.inject.Inject

/**
 * US-2792: the five facts SyncStatusBar needs, combined into the one it shows.
 *
 * SyncStatusBar has existed since US-1322 with nothing rendering it — 119 lines
 * of sync UI no screen showed. It was NOT missing a design: [SyncStatus.derive]
 * is pure, already written and already tested, including the priority order
 * (stuck beats syncing beats queued beats link state). What was missing was
 * somewhere to get its five arguments.
 *
 * All five are observable now:
 *  - stuck / pending  PendingMutationDao, counted separately because they mean
 *                     different things to a seller (see the DAO's comment)
 *  - syncing          SyncService, the @Singleton — NOT SyncCoordinator, which
 *                     is built per pull and unreachable from outside
 *  - online           ConnectivityMonitor
 *  - reconnecting     RealtimeService.phase
 *
 * WhileSubscribed, not Eagerly: the bar is IDLE most of the time and renders
 * nothing, so there is no reason to hold a Room query open while no screen is
 * looking at it.
 */
@HiltViewModel
class SyncStatusViewModel @Inject constructor(
    @ApplicationContext context: Context,
    db: GradeThreadDb,
    syncService: SyncService,
    realtime: RealtimeService,
) : ViewModel() {

    data class State(
        val status: SyncStatus = SyncStatus.IDLE,
        val pendingCount: Int = 0,
        val stuckCount: Int = 0,
    )

    private val connectivity = ConnectivityMonitor(context)

    val state: StateFlow<State> = combine(
        db.pendingMutations().observePendingCount(OfflineMutationQueue.MAX_RETRIES),
        db.pendingMutations().observeStuckCount(OfflineMutationQueue.MAX_RETRIES),
        syncService.syncing,
        connectivity.online,
        realtime.phase,
    ) { pending, stuck, syncing, online, phase ->
        State(
            status = SyncStatus.derive(
                stuckCount = stuck,
                syncing = syncing,
                pendingCount = pending,
                online = online,
                // DISABLED is not RECONNECTING. Realtime being switched off is a
                // settled state, and showing "Reconnecting…" forever for it would
                // be the loudest possible way to say nothing is wrong.
                reconnecting = phase == RealtimeService.Phase.RECONNECTING,
            ),
            pendingCount = pending,
            stuckCount = stuck,
        )
    }.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS),
        initialValue = State(),
    )

    private companion object {
        /** Survives a rotation without tearing the Room queries down and back up. */
        const val STOP_TIMEOUT_MS = 5_000L
    }
}
