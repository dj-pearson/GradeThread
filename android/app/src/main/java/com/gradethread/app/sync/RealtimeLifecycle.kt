package com.gradethread.app.sync

/**
 * US-2367: when the realtime channel should be up.
 *
 * Pure, because the socket's cost is invisible: a channel left open in the
 * background quietly drains battery and data, and a channel that failed to come
 * back after a fold or a sign-in just means the app silently stops updating.
 * Neither shows up on screen, so neither is caught by looking.
 */
object RealtimeLifecycle {

    enum class Action {
        /** Open (or keep) the channel for the current owner. */
        START,

        /** Tear the socket down entirely. */
        PAUSE,

        /** Already in the right state. */
        NONE,
    }

    /**
     * What to do given the world and the current phase.
     *
     * The order of the checks is the contract. Signed-out and disabled are
     * checked BEFORE foreground, because a socket open under a signed-out
     * session is authenticated with a token that is being thrown away, and the
     * server closing it is not a state the client should be racing.
     */
    fun decide(
        signedIn: Boolean,
        foreground: Boolean,
        enabled: Boolean,
        phase: RealtimeService.Phase,
    ): Action {
        val wanted = signedIn && foreground && enabled
        val up = phase == RealtimeService.Phase.SUBSCRIBED ||
            phase == RealtimeService.Phase.SUBSCRIBING ||
            phase == RealtimeService.Phase.RECONNECTING
        return when {
            wanted && !up -> Action.START
            !wanted && up -> Action.PAUSE
            else -> Action.NONE
        }
    }

    /**
     * Whether a workspace switch needs the channel re-homed.
     *
     * Only when it is actually up. Re-homing an idle channel would OPEN one in
     * the background, which is the opposite of what a pause just achieved.
     */
    fun shouldRehome(phase: RealtimeService.Phase): Boolean =
        phase != RealtimeService.Phase.IDLE && phase != RealtimeService.Phase.DISABLED
}
