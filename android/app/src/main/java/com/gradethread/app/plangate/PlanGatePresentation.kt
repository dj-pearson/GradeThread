package com.gradethread.app.plangate

import com.gradethread.app.platform.net.PlanGateError
import com.gradethread.app.platform.net.PlanWarning

/**
 * US-1367: what the shell shows when the plan gets in the way.
 *
 * Two signals arrive from [com.gradethread.app.platform.net.PlanGateNotifier] on
 * every response: a 402 hard cap and an 80% soft warning. Pure state machine,
 * because the interesting behaviour is all about NOT nagging — a seller doing a
 * bulk run generates dozens of identical warnings, and showing each one would
 * make the shell unusable at exactly the moment they are working hardest.
 */
object PlanGatePresentation {

    data class State(
        /** The hard wall, shown as a dialog. */
        val gate: PlanGateError? = null,
        /** The soft warning, shown as a banner. */
        val warning: PlanWarning? = null,
        /** Warning buckets the seller has waved away this session. */
        val dismissed: Set<String> = emptySet(),
    )

    /**
     * The identity of a warning.
     *
     * Keyed by kind AND limit, not by kind alone: a dismissed "you're near your
     * 250 listings" must come back when the limit changes, because after an
     * upgrade or a new month it is a different fact about a different number.
     */
    fun bucket(warning: PlanWarning): String = "${warning.kind}:${warning.limit}"

    /**
     * A hard cap always shows, and always replaces whatever came before.
     *
     * It also clears the banner for the same capacity: once you have actually
     * hit the wall, "you're at 80%" is stale and shows a smaller number than the
     * dialog above it.
     */
    fun onGate(state: State, gate: PlanGateError): State = state.copy(
        gate = gate,
        warning = state.warning?.takeIf { it.kind != gate.cap },
    )

    /**
     * A soft warning shows once per bucket, and never over a hard wall.
     *
     * A warning that isn't actually a warning is dropped rather than rendered:
     * the header can arrive with a zero limit or a used count past the limit,
     * and "you have used 300 of 250" is a support ticket, not a nudge.
     */
    fun onWarning(state: State, warning: PlanWarning): State {
        if (!meaningful(warning)) return state
        if (state.gate != null) return state
        if (bucket(warning) in state.dismissed) return state
        return state.copy(warning = warning)
    }

    fun meaningful(warning: PlanWarning): Boolean =
        warning.limit > 0 && warning.used in 0..warning.limit

    /** Dismissing a banner silences that bucket for the rest of the session. */
    fun dismissWarning(state: State): State {
        val current = state.warning ?: return state
        return state.copy(warning = null, dismissed = state.dismissed + bucket(current))
    }

    /** Closing the dialog leaves the seller where they were, not upgraded. */
    fun dismissGate(state: State): State = state.copy(gate = null)

    /**
     * How full the bar is, 0..1.
     *
     * Clamped, because a server that reports 260 of 250 should render a full bar
     * rather than a bar that overflows its own track.
     */
    fun progress(warning: PlanWarning): Float =
        if (warning.limit <= 0) 1f else (warning.used.toFloat() / warning.limit).coerceIn(0f, 1f)

    /** "You've used 210 of your 250 active listings." */
    fun warningMessage(warning: PlanWarning): String =
        "You've used ${warning.used} of your ${warning.limit} " +
            "${PlanGateError.capLabel(warning.kind)} allowance."

    /**
     * Whether the upgrade dialog should offer an upgrade at all.
     *
     * A FEATURE_LOCKED gate naming no required plan has nothing to sell — the
     * button would be a shrug with a chevron on it.
     */
    fun offersUpgrade(gate: PlanGateError): Boolean =
        gate.requiredPlan != null || gate.isFeatureLock || gate.cap != null
}
