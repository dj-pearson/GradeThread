package com.gradethread.app.ai

/**
 * US-1334: the publish gate — how long the extraction holds before it calls
 * the server, and what "the photos landed" means.
 *
 * The extract sends URLs, so it cannot run until the bytes are in storage AND
 * the `item_photos` row exists. iOS learned this the expensive way: a gate
 * that could satisfy vacuously while the upload tasks were still registering
 * sent fewer photos than the seller shot and left an "Untitled" item.
 *
 * Pure, so the timeout/grace/required rules are provable without WorkManager.
 */
object AiExtractGate {

    /**
     * How long to wait before giving up on the uploads. 60s was not enough on
     * a slow connection (the iOS US-686 follow-up); the run then bailed with
     * nothing to send.
     */
    const val TIMEOUT_MS: Long = 180_000

    /**
     * Uploads are enqueued asynchronously, so the first poll can legitimately
     * see nothing settled. Without this floor an empty set satisfies
     * [isSettled] vacuously and the run proceeds with zero photos.
     */
    const val REGISTER_GRACE_MS: Long = 1_500

    const val POLL_INTERVAL_MS: Long = 250

    /**
     * Is the gate open?
     *
     * @param gate the sort orders that must settle — the REQUIRED photos when
     *   any were captured, else all of them. A slow or failed OPTIONAL photo
     *   (detail, measurements, …) must never stall the AI.
     * @param settled sort orders that reached a terminal state: uploaded (an
     *   `item_photos` row exists) or terminally failed. Failure counts as
     *   settled on purpose — a dead required photo should surface the retry
     *   prompt immediately, not spin for the full [TIMEOUT_MS].
     */
    fun isSettled(gate: Set<Int>, settled: Set<Int>, elapsedMs: Long): Boolean = when {
        elapsedMs >= TIMEOUT_MS -> true
        elapsedMs < REGISTER_GRACE_MS -> false
        // An empty gate would otherwise return true instantly; there is
        // nothing to wait for, but the grace floor above still applies so a
        // just-enqueued upload has a chance to register.
        else -> gate.all { it in settled }
    }

    /** The `uploading(done, total)` progress the sheet renders. */
    fun progress(landed: Int, total: Int): AiExtractPhase.Uploading =
        AiExtractPhase.Uploading(done = landed.coerceIn(0, total), total = total)
}
