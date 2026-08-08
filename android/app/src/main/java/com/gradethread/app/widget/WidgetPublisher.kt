package com.gradethread.app.widget

import android.content.Context
import androidx.glance.appwidget.updateAll
import com.gradethread.app.platform.shortcuts.AppShortcuts
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.sync.db.GradeThreadDb
import java.util.concurrent.atomic.AtomicLong

/**
 * US-1380 (iOS `WidgetSnapshotPublisher`): computes the snapshot after a sync
 * and pushes it to the home screen.
 *
 * The interesting part is [decide], which is pure. Reloading every widget is
 * not free — the system redraws every instance the seller has placed — so a
 * burst of syncs must not become a burst of redraws, and a rule that decides
 * when to skip has to be testable without an AppWidgetHost.
 */
object WidgetPublisher {

    /** The floor between two reloads. */
    const val MIN_RELOAD_INTERVAL_MS = 30_000L

    /** What a publish should actually do. */
    enum class Action {
        /** The numbers are identical — no write, no redraw. */
        SKIP,

        /**
         * Store it, but hold the redraw: we reloaded too recently.
         *
         * Unlike iOS, which simply drops the reload, Android schedules a
         * catch-up worker for the rest of the window — otherwise a change that
         * lands one second after a reload is stranded until the next sync.
         *
         * Only ever applies once something REAL has been drawn — see the
         * first-publish branch in [decide].
         */
        WRITE_ONLY,

        WRITE_AND_RELOAD,
    }

    fun decide(
        previous: WidgetSnapshot?,
        next: WidgetSnapshot,
        lastReloadAtMs: Long,
        nowMs: Long,
        minIntervalMs: Long = MIN_RELOAD_INTERVAL_MS,
    ): Action {
        // US-2435: nothing stored yet means the widget is showing PLACEHOLDER
        // figures — 12 listings, 3 sales, $184.00 — that were never this
        // seller's. Holding that behind the rate limit is not coalescing a
        // redraw, it is leaving invented numbers on someone's home screen, so
        // the first real publish always redraws.
        //
        // Production mostly hid this: `lastReloadAt` is seeded to
        // Long.MIN_VALUE / 2, which makes `since` enormous on the first publish
        // of a PROCESS. But `previous == null` also happens mid-process — most
        // plausibly when the stored JSON fails to decode after an upgrade
        // changed its shape (WidgetSnapshotStore.read returns null) — and then
        // any reload in the last 30s pushed it to WRITE_ONLY. The invariant now
        // holds in the pure function rather than depending on a sentinel.
        if (previous == null) return Action.WRITE_AND_RELOAD
        if (previous.hasSameRollup(next)) return Action.SKIP
        // `nowMs - lastReloadAtMs` rather than a stored deadline: a clock that
        // jumps backwards then yields a negative gap, which fails the test and
        // holds the reload for one window instead of firing forever.
        val since = nowMs - lastReloadAtMs
        return if (since >= minIntervalMs || since < 0L) Action.WRITE_AND_RELOAD else Action.WRITE_ONLY
    }

    /** How long the catch-up worker should wait before redrawing. */
    fun catchUpDelayMs(
        lastReloadAtMs: Long,
        nowMs: Long,
        minIntervalMs: Long = MIN_RELOAD_INTERVAL_MS,
    ): Long = (minIntervalMs - (nowMs - lastReloadAtMs)).coerceIn(0L, minIntervalMs)

    /** Process-lifetime, because the widget itself is process-lifetime. */
    private val lastReloadAt = AtomicLong(Long.MIN_VALUE / 2)

    /**
     * Roll up from Room and publish.
     *
     * Reads listings and sales only. Everything else the app knows is
     * irrelevant to three numbers, and a widget publish riding on the tail of
     * every sync is not the place to load the whole cache.
     */
    suspend fun publish(context: Context, db: GradeThreadDb, isSignedIn: Boolean, nowMs: Long) {
        val snapshot = if (isSignedIn) {
            WidgetRollup.compute(
                listings = db.listings().all(),
                sales = db.sales().all(),
                nowMs = nowMs,
                isSignedIn = true,
            )
        } else {
            WidgetSnapshot.signedOut(generatedAt = nowMs)
        }
        publish(context, snapshot, nowMs)
    }

    suspend fun publish(context: Context, snapshot: WidgetSnapshot, nowMs: Long) {
        val previous = WidgetSnapshotStore.read(context)
        when (decide(previous, snapshot, lastReloadAt.get(), nowMs)) {
            Action.SKIP -> return

            Action.WRITE_ONLY -> {
                WidgetSnapshotStore.write(context, snapshot)
                WidgetReloadWorker.enqueue(
                    context,
                    catchUpDelayMs(lastReloadAt.get(), nowMs),
                )
            }

            Action.WRITE_AND_RELOAD -> {
                WidgetSnapshotStore.write(context, snapshot)
                lastReloadAt.set(nowMs)
                reload(context)
            }
        }
        // US-1381: the "what sold today" shortcut's LABEL is the answer, read
        // off the long-press menu with no launch and no network. It is pushed
        // here rather than coalesced with the widget redraw because writing a
        // label is cheap — it is the redraw of every placed widget that isn't.
        AppShortcuts.refresh(context, snapshot)
    }

    /**
     * Sign-out.
     *
     * Never coalesced, never skipped: the widget is showing one person's
     * takings on a screen the next person to pick up the phone can see. This
     * one redraw is worth jumping the queue for.
     */
    suspend fun publishSignedOut(context: Context, nowMs: Long) {
        WidgetSnapshotStore.clear(context, nowMs)
        lastReloadAt.set(nowMs)
        reload(context)
        // The shortcut label carries the same figures, on the same home screen.
        AppShortcuts.refresh(context, WidgetSnapshot.signedOut(nowMs))
    }

    internal suspend fun reload(context: Context) {
        // Wrapped: a device with no widget placed, or a host that has gone
        // away, throws here — and a failed redraw must never fail the sync it
        // was riding on.
        runCatching { SellerSnapshotWidget.updateAll(context) }
            .onFailure { Telemetry.breadcrumb("widget reload failed: ${it.message}", "widget") }
    }
}
