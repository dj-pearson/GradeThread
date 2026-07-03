package com.gradethread.app.platform.net

import kotlin.math.min
import kotlin.math.pow

/**
 * US-1306: exponential-backoff delay (iOS Backoff, US-638). Shared by the
 * transient-failure retry and any poller so fixed-interval hammering backs
 * off as a wait drags on.
 */
object Backoff {

    /** Delay in ms for a 0-based attempt: `base * 2^attempt`, capped. */
    fun delayMillis(attempt: Int, baseMillis: Long = 1_000, capMillis: Long = 8_000): Long {
        val exponent = maxOf(attempt, 0)
        val raw = baseMillis * 2.0.pow(exponent)
        return min(capMillis.toDouble(), raw).toLong().coerceAtLeast(0)
    }
}
