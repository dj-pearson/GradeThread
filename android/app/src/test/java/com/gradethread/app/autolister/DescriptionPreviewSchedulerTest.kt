package com.gradethread.app.autolister

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-2964: the two properties the preview scheduler exists for, tested directly
 * on virtual time. Mirrors `src/lib/__tests__/description-preview.test.ts`.
 */
class DescriptionPreviewSchedulerTest {

    /** Typing fires ONE request, not one per keystroke. */
    @Test
    fun `the debounce collapses rapid requests into one`() = runTest {
        val calls = mutableListOf<String>()
        val results = mutableListOf<String>()
        val scheduler = DescriptionPreviewScheduler<String, String>(
            scope = CoroutineScope(StandardTestDispatcher(testScheduler)),
            fetcher = { payload ->
                calls += payload
                payload.uppercase()
            },
            onResult = { results += it },
        )

        scheduler.request("a")
        advanceTimeBy(100)
        scheduler.request("ab")
        advanceTimeBy(100)
        scheduler.request("abc")
        advanceUntilIdle()

        assertEquals(listOf("abc"), calls)
        assertEquals(listOf("ABC"), results)
    }

    /**
     * The one that matters. A slow EARLIER render landing after a fast LATER one
     * would put stale bytes under a seller who is about to publish them.
     */
    @Test
    fun `the last request wins when an earlier render settles last`() = runTest {
        val results = mutableListOf<String>()
        val scheduler = DescriptionPreviewScheduler<String, String>(
            scope = CoroutineScope(StandardTestDispatcher(testScheduler)),
            fetcher = { payload ->
                // "slow" takes long enough to land after "fast" has already been
                // delivered.
                if (payload == "slow") delay(5_000)
                payload
            },
            onResult = { results += it },
        )

        scheduler.request("slow")
        // Past the debounce, so the slow fetch has actually started.
        advanceTimeBy(DescriptionPreviewScheduler.DEBOUNCE_MILLIS + 100)
        scheduler.request("fast")
        advanceUntilIdle()

        assertEquals(listOf("fast"), results)
    }

    /**
     * Cancelling orphans everything in flight, so a screen going away cannot
     * write into dead state.
     */
    @Test
    fun `cancel drops the pending request and the one in flight`() = runTest {
        val results = mutableListOf<String>()
        val pending = mutableListOf<Boolean>()
        val scheduler = DescriptionPreviewScheduler<String, String>(
            scope = CoroutineScope(StandardTestDispatcher(testScheduler)),
            fetcher = { payload ->
                delay(5_000)
                payload
            },
            onResult = { results += it },
            onPending = { pending += it },
        )

        scheduler.request("one")
        advanceTimeBy(DescriptionPreviewScheduler.DEBOUNCE_MILLIS + 100)
        scheduler.cancel()
        advanceUntilIdle()

        assertTrue(results.isEmpty())
        assertEquals(false, pending.last())
    }

    @Test
    fun `pending is raised for the request and lowered when it settles`() = runTest {
        val pending = mutableListOf<Boolean>()
        val scheduler = DescriptionPreviewScheduler<String, String>(
            scope = CoroutineScope(StandardTestDispatcher(testScheduler)),
            fetcher = { it },
            onResult = { },
            onPending = { pending += it },
        )

        scheduler.request("x")
        advanceUntilIdle()

        assertEquals(listOf(true, false), pending)
    }
}
