package com.gradethread.app.intake

import android.content.Context
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.gradethread.app.capture.PhotoIntakeStore
import com.gradethread.app.platform.deeplink.DeepLinkController
import com.gradethread.app.platform.deeplink.DeepLinkRoute
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.sync.db.GradeThreadDb
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.io.File
import javax.inject.Inject
import javax.inject.Singleton

/**
 * US-1382: shared photos becoming a capture session.
 *
 * Runs on every foreground, because that is the moment the seller is actually
 * looking. It sweeps stale batches, folds the oldest pending one into the
 * capture draft the camera screen already restores from, and routes there.
 *
 * The draft is the handoff. Reusing it rather than inventing a second channel
 * means a share and a half-finished camera session cannot end up describing two
 * different intakes.
 */
@Singleton
class IntakeDrainer @Inject constructor(
    @ApplicationContext private val context: Context,
    private val db: GradeThreadDb,
) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    companion object {
        /**
         * A one-shot line for the capture screen to show.
         *
         * Process-wide rather than injected, like [DeepLinkController.shared]:
         * the drain runs from the application scope with no screen up, and the
         * screen that eventually shows it is a composable with no ViewModel of
         * its own. Non-null ONLY when something needs saying — photos that
         * wouldn't fit, or a share that produced nothing. A silent failure here
         * looks exactly like the app losing someone's photos.
         */
        private val messageFlow = MutableStateFlow<String?>(null)
        val lastMessage: StateFlow<String?> = messageFlow

        fun clearMessage() {
            messageFlow.value = null
        }
    }

    /** Call once, from Application.onCreate. */
    fun observeForeground() {
        ProcessLifecycleOwner.get().lifecycle.addObserver(
            object : DefaultLifecycleObserver {
                override fun onStart(owner: LifecycleOwner) {
                    scope.launch { runCatching { drain() } }
                }
            },
        )
    }

    suspend fun drain(nowMs: Long = System.currentTimeMillis()) {
        IntakeInboxStore.sweepOrphans(context, db)

        val pending = IntakeInboxStore.pending(db)
        IntakeInbox.stale(pending, nowMs).forEach { batch ->
            Telemetry.event("intake_batch_swept", mapOf("age_days" to (nowMs - batch.createdAt) / 86_400_000L))
            IntakeInboxStore.consume(context, db, batch.id)
        }

        val batch = pending.firstOrNull { it !in IntakeInbox.stale(pending, nowMs) } ?: return

        // Files can vanish between the share and the open — a cleaner, a
        // restore, a user clearing app storage. Filtered here so the drain
        // reports "couldn't read 3" rather than placing paths that render blank.
        val readable = batch.photos.filter { File(it.path).let { f -> f.exists() && f.length() > 0 } }
        val failed = batch.photos.size - readable.size

        val existing = PhotoIntakeStore.restore(db).state.value
        val result = IntakeInbox.drainInto(existing, batch.copy(photos = readable))

        if (result.added > 0) {
            PhotoIntakeStore(result.state).persist(db) { nowMs }
        }
        // Consumed either way. A batch we could not place will not become
        // placeable later, and replaying it every foreground is its own bug.
        IntakeInboxStore.consume(context, db, batch.id)

        messageFlow.value = IntakeInbox.message(result, failed)
        Telemetry.event(
            "intake_batch_drained",
            mapOf("added" to result.added, "dropped" to result.dropped, "unreadable" to failed),
        )

        if (result.added > 0) {
            // Straight to the camera, with the shared frames already in place.
            DeepLinkController.shared.offer(
                android.net.Uri.parse(DeepLinkRoute.CaptureItem.toDeepLinkUri()),
                isReady = true,
            )
        }
    }
}
