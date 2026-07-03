package com.gradethread.app.platform.deeplink

import android.net.Uri
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow

/**
 * US-1314: the inbound deep-link pipeline (iOS DeepLinkGate + pendingDeepLink,
 * US-1156):
 *
 *  1. GATE — any installed app can fire the custom scheme; a spam burst is
 *     rate-limited (250ms floor between accepted links; real taps never
 *     arrive faster) so it can't spawn unbounded work or ANR the app.
 *  2. PARSE — [DeepLinkRoute.fromUri]; non-ours falls through untouched.
 *  3. READY? — a link arriving before sign-in completes is QUEUED (single
 *     slot: only the latest intent matters) and replayed via [replayPending]
 *     once auth lands, instead of being silently dropped.
 *
 * Accepted routes emit on [routes]; the shell collects and navigates.
 */
class DeepLinkController(
    private val minIntervalMs: Long = 250,
    private val clock: () -> Long = System::currentTimeMillis,
) {

    private val routesFlow = MutableSharedFlow<DeepLinkRoute>(extraBufferCapacity = 4)
    val routes: SharedFlow<DeepLinkRoute> = routesFlow

    private var lastAcceptedAt: Long? = null
    private var pending: DeepLinkRoute? = null

    /** Pure gate decision (iOS DeepLinkGate.shouldAccept). */
    fun shouldAccept(lastMs: Long?, nowMs: Long): Boolean =
        lastMs == null || nowMs - lastMs >= minIntervalMs

    /**
     * Feed an inbound Uri. [isReady] = the shell can route right now (signed
     * in, nav graph up); false queues for [replayPending].
     */
    fun offer(uri: Uri?, isReady: Boolean) {
        val now = clock()
        if (!shouldAccept(lastAcceptedAt, now)) return
        val route = DeepLinkRoute.fromUri(uri) ?: return
        lastAcceptedAt = now
        if (isReady) {
            routesFlow.tryEmit(route)
        } else {
            // Single slot: a newer link supersedes an older queued one.
            pending = route
        }
    }

    /** Replay the queued link (if any) once sign-in completes. */
    fun replayPending() {
        pending?.let {
            pending = null
            routesFlow.tryEmit(it)
        }
    }

    /** The queued route without consuming it (for tests/inspection). */
    fun peekPending(): DeepLinkRoute? = pending

    companion object {
        /** Process-wide instance MainActivity feeds and the shell collects. */
        val shared = DeepLinkController()
    }
}
