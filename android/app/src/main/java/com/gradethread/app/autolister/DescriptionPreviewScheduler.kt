package com.gradethread.app.autolister

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * US-2964: the description preview's request scheduler, ported from
 * `src/lib/description-preview.ts`.
 *
 * The preview shows the exact string the marketplace will receive, which only
 * the edge renderer can produce, so every keystroke in a block editor is a
 * potential round trip. Two things have to hold and neither is free:
 *
 *  1. DEBOUNCE. 400ms, the same figure the web and iOS use. Typing an intro must
 *     not fire a request per character.
 *  2. LAST REQUEST WINS. Two in-flight renders can come back in either order,
 *     and a slow EARLIER one landing after a fast LATER one would put stale
 *     bytes under a seller who is about to publish them. The sequence number
 *     here is what makes that impossible - a response whose sequence is not the
 *     newest issued is dropped, not delivered.
 *
 * [issued] is touched from more than one coroutine but only ever on the scope's
 * single dispatcher (the main one in the app, the test one under `runTest`), so
 * it needs no lock.
 */
class DescriptionPreviewScheduler<P, R>(
    private val scope: CoroutineScope,
    private val fetcher: suspend (P) -> R,
    private val onResult: (R) -> Unit,
    private val onPending: (Boolean) -> Unit = {},
    private val onError: (Throwable) -> Unit = {},
    private val delayMillis: Long = DEBOUNCE_MILLIS,
) {

    companion object {
        /** The debounce window, shared with the web so the two behave alike. */
        const val DEBOUNCE_MILLIS = 400L
    }

    /** The debounce timer, and ONLY the timer. See [request]. */
    private var timer: Job? = null

    /**
     * Monotonic. The newest request's number; a settled response is only allowed
     * to speak if it still carries it.
     */
    private var issued = 0L

    /** Queue a render. Resets the debounce window. */
    fun request(payload: P) {
        timer?.cancel()
        timer = scope.launch {
            delay(delayMillis)
            // A SEPARATE job, deliberately: a newer request must not cancel the
            // call an older one already started. Cancelling would look like it
            // was doing the same job as the sequence number and would quietly
            // replace it, so the guard that actually protects the seller would
            // stop being exercised - and an already-answered request would be
            // thrown away for nothing.
            scope.launch { fire(payload) }
        }
    }

    /** Drop the pending timer and orphan every response still in flight. */
    fun cancel() {
        timer?.cancel()
        timer = null
        issued += 1
        onPending(false)
    }

    private suspend fun fire(payload: P) {
        issued += 1
        val seq = issued
        onPending(true)
        val result = runCatching { fetcher(payload) }
        if (seq != issued) return // a newer request has already gone out
        onPending(false)
        result.onSuccess(onResult).onFailure(onError)
    }
}
