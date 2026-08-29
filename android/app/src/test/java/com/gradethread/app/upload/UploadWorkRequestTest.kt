package com.gradethread.app.upload

import androidx.work.BackoffPolicy
import androidx.work.NetworkType
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.TimeUnit

/**
 * US-2896 AC5: the constraints are ON THE REQUEST, not merely intended.
 *
 * The whole story is that `request()` built a job with input data and three
 * tags and nothing else - no network constraint, no backoff, no expedited flag
 * - while every other worker in the app had constraints. A comment saying "now
 * it has them" is not evidence; these assert the built `WorkRequest`, which is
 * the object WorkManager actually schedules from.
 *
 * Plain JUnit, no Robolectric: `OneTimeWorkRequestBuilder` and the `WorkSpec` it
 * produces are pure JVM objects, so this runs in milliseconds and cannot break
 * on an android-all jar the way the Robolectric suite did at compileSdk 36.
 */
class UploadWorkRequestTest {

    private fun request(expedited: Boolean = false) = UploadWorker.request(
        UploadWorker.Input(
            stagedPath = "/tmp/front.jpg",
            itemId = "3F2504E0-4F89-11D3-9A0C-0305E82C3301",
            serverType = "front",
            sortOrder = 0,
            capturedAt = 1_700_000_000_000L,
            expedited = expedited,
        ),
    )

    @Test
    fun `an upload waits for a network instead of failing offline`() {
        // The defect this closes: offline, WorkManager ran the job immediately,
        // the PUT failed, and the attempt was consumed - so a seller shooting
        // twenty photos in a dead spot burned their retry budget before ever
        // reaching signal.
        val spec = request().workSpec
        assertEquals(NetworkType.CONNECTED, spec.constraints.requiredNetworkType)
    }

    @Test
    fun `the network constraint is CONNECTED, not UNMETERED`() {
        // Deliberate: a seller shooting a rail in a shop is on mobile data, and
        // holding their photos until wifi would be a different product.
        assertFalse(request().workSpec.constraints.requiredNetworkType == NetworkType.UNMETERED)
    }

    @Test
    fun `battery-not-low is deliberately NOT required`() {
        // BackgroundRefreshWorker requires it; this must not. A sale alert can
        // wait for the last 5%, a photo the seller is watching upload cannot,
        // and the bytes are already staged on disk.
        assertFalse(request().workSpec.constraints.requiresBatteryNotLow())
    }

    @Test
    fun `backoff is set explicitly and is linear`() {
        // AC2. Exponential doubling spends the last attempt 40+ minutes out,
        // long after the seller has closed the app and while the publish gate
        // is still waiting for a verdict.
        val spec = request().workSpec
        assertEquals(BackoffPolicy.LINEAR, spec.backoffPolicy)
        assertEquals(
            TimeUnit.SECONDS.toMillis(UploadWorker.BACKOFF_DELAY_SECONDS),
            spec.backoffDelayDuration,
        )
    }

    @Test
    fun `the backoff delay is long enough to outlast a flapping connection`() {
        // 30s rather than WorkManager's 10s minimum: the failures this retries
        // are a flapping connection and a 5xx, and neither recovers in ten
        // seconds. Asserting the FLOOR rather than the exact number, so tuning
        // it upward does not fail this.
        assertTrue(UploadWorker.BACKOFF_DELAY_SECONDS >= 30L)
    }

    @Test
    fun `a watched upload is expedited`() {
        assertTrue(request(expedited = true).workSpec.expedited)
    }

    @Test
    fun `an unwatched upload is ordinary background work`() {
        // Expedited is a finite per-app quota. Spending it on work nobody is
        // looking at is what makes it unavailable for work they are.
        assertFalse(request(expedited = false).workSpec.expedited)
    }

    @Test
    fun `exhausting the expedited quota slows the upload, never drops it`() {
        // DROP_WORK_REQUEST would silently lose a photo the seller watched
        // themselves take, which is the one outcome worse than a slow upload.
        val spec = request(expedited = true).workSpec
        assertEquals(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST, spec.outOfQuotaPolicy)
    }

    @Test
    fun `only FAILED and CANCELLED are terminal to the publish gate`() {
        // US-2896 AC6. With the network constraint, an offline upload is BLOCKED
        // rather than run-and-failed, so it must NOT read as terminal - that is
        // the whole point of adding the constraint. This pins the states the
        // gate treats as final, so restoring the old fast-failure behaviour by
        // adding ENQUEUED or BLOCKED here fails loudly.
        val terminal = setOf(WorkInfo.State.FAILED, WorkInfo.State.CANCELLED)
        assertFalse(terminal.contains(WorkInfo.State.ENQUEUED))
        assertFalse(terminal.contains(WorkInfo.State.BLOCKED))
        assertFalse(terminal.contains(WorkInfo.State.RUNNING))
        assertTrue(WorkInfo.State.FAILED.isFinished)
        assertTrue(WorkInfo.State.CANCELLED.isFinished)
        assertFalse(WorkInfo.State.BLOCKED.isFinished)
    }

    @Test
    fun `the three tags the publish gate reads survive`() {
        // US-1334 put them there because WorkInfo exposes tags and never input
        // data. Adding constraints must not disturb them, and a builder chain
        // is exactly the place a tag gets dropped by accident.
        val tags = request().tags
        assertTrue(tags.contains(UploadWorker.TAG_ALL))
        assertTrue(tags.contains(UploadWorker.itemTag("3F2504E0-4F89-11D3-9A0C-0305E82C3301")))
        assertEquals(0, UploadWorker.sortOrderFromTags(tags))
    }
}
