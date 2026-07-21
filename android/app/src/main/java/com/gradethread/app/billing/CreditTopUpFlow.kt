package com.gradethread.app.billing

import com.gradethread.app.platform.net.Backoff

/**
 * US-1338: what happens between "the buyer paid" and "the submit button
 * unblocks" (iOS `CreditTopUpFlow`, US-809).
 *
 * Pure over injected seams — the balance read and the sleep are both passed in
 * — so the whole machine unit-tests with no Play Store and no network.
 *
 * It never submits anything. It only unblocks the submit button that was
 * already there, so there is no double-grant risk here; the server's grant RPC
 * is independently idempotent by purchase token.
 */
object CreditTopUpFlow {

    /**
     * Bounded so a grant that never lands still returns control. 12 attempts at
     * 1,2,4,8,8,… is ~78s — long enough for Play's own propagation, short
     * enough that a seller isn't watching a spinner indefinitely.
     */
    const val MAX_POLLS = 12

    sealed class State {
        object Idle : State()

        /** Play's purchase dialog is up. */
        object Purchasing : State()

        /** Paid; waiting for the credits to appear on the account. */
        object AwaitingGrant : State()

        data class Granted(val balance: Int) : State()

        /**
         * The grant didn't appear in the window. NOT an error state — the sheet
         * stays usable and offers "Check again", because the overwhelmingly
         * likely cause is propagation lag, not a lost purchase.
         */
        object TimedOut : State()

        data class Failed(val message: String) : State()
    }

    /**
     * Did the grant land?
     *
     * Detected by a STRICT INCREASE over the pre-purchase balance rather than
     * by an absolute target, which is what makes it tolerant of a transient
     * read failure (null just retries) and of a second grant arriving from
     * another device mid-poll.
     */
    fun granted(baseline: Int, balance: Int?): Boolean = balance != null && balance > baseline

    /** Backoff between polls; mirrors the grading poll's curve. */
    fun delayFor(attempt: Int): Long = Backoff.delayMillis(attempt, baseMillis = 1_000, capMillis = 8_000)

    /**
     * Poll until the balance rises above [baseline] or the window elapses.
     *
     * @param verifiedBalance the balance the verify call itself reported, if
     *   any. The Android verify endpoint applies the grant BEFORE it responds,
     *   so this is usually authoritative immediately and no polling happens at
     *   all — unlike iOS, where StoreKit confirms first and the grant lands out
     *   of band. The poll remains as the fallback for a response we didn't get
     *   to read (dropped connection after the server committed).
     * @return the terminal state; [State.TimedOut] still means "re-validate",
     *   never "the purchase failed".
     */
    suspend fun awaitGrant(
        baseline: Int,
        verifiedBalance: Int?,
        fetchBalance: suspend () -> Int?,
        sleep: suspend (Long) -> Unit,
        maxPolls: Int = MAX_POLLS,
    ): State {
        if (granted(baseline, verifiedBalance)) return State.Granted(verifiedBalance!!)

        for (attempt in 0 until maxPolls) {
            val balance = fetchBalance()
            if (granted(baseline, balance)) return State.Granted(balance!!)
            // No sleep after the final attempt — we're about to give up anyway.
            if (attempt < maxPolls - 1) sleep(delayFor(attempt))
        }
        return State.TimedOut
    }
}
