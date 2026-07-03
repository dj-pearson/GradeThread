package com.gradethread.app.sync

import com.gradethread.app.platform.telemetry.Telemetry
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.util.concurrent.atomic.AtomicInteger

/**
 * US-1322 / US-1142 (iOS PersistenceHealth): a Room write failing (disk
 * full, corruption under pressure) must never vanish silently. Every failure
 * records a SCRUBBED breadcrumb (always — diagnostics); once failures are
 * PERSISTENT (>= [NOTICE_THRESHOLD], not a single transient blip) a one-time
 * "couldn't save on this device" notice surfaces. Acknowledging resets the
 * counter so the notice can re-arm if trouble continues.
 */
object PersistenceHealth {

    const val NOTICE_THRESHOLD = 3

    private val failureCount = AtomicInteger(0)
    private val noticeFlow = MutableStateFlow(false)

    /** The shell binds an alert to this ("couldn't save on this device"). */
    val noticeNeeded: StateFlow<Boolean> = noticeFlow

    /** Record a local-save failure from any thread. */
    fun recordSaveFailure(operation: String, error: Throwable) {
        Telemetry.breadcrumb(
            "Room save failed [$operation]: ${error.message ?: error.javaClass.simpleName}",
            category = "persistence",
        )
        if (failureCount.incrementAndGet() >= NOTICE_THRESHOLD) {
            noticeFlow.value = true
        }
    }

    /** User acknowledged — reset so the notice re-arms only on NEW trouble. */
    fun acknowledgeNotice() {
        failureCount.set(0)
        noticeFlow.value = false
    }

    /** Test seam. */
    internal fun resetForTest() = acknowledgeNotice()
}
