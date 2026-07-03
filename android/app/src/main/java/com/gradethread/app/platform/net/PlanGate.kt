package com.gradethread.app.platform.net

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * US-1306: plan-gate signals (iOS PlanGate.swift, US-805; mirrors web
 * US-209/US-210). Two shapes decoded centrally in [EdgeApi] so every call
 * gets the upgrade-prompt + soft-warning behavior without per-call wiring:
 *  • a hard cap → HTTP 402 with a JSON [PlanGateError] body;
 *  • an 80% soft-warn → the `X-Plan-Warning` header ([PlanWarning]), which
 *    can ride on ANY status.
 */

/** Decoded 402 body — keys emitted verbatim by plan-gate.ts. */
@Serializable
data class PlanGateError(
    /** "CAP_REACHED" | "FEATURE_LOCKED". */
    val error: String? = null,
    /** Capacity kind for CAP_REACHED (activeListings / aiActions / …). */
    val cap: String? = null,
    val used: Int? = null,
    val limit: Int? = null,
    val plan: String? = null,
    val requiredPlan: String? = null,
    val feature: String? = null,
) {
    val isFeatureLock: Boolean get() = error == "FEATURE_LOCKED"

    val title: String
        get() = if (isFeatureLock) "That's a paid feature"
        else "You've reached your ${capLabel(cap)} limit"

    val usageDetail: String?
        get() {
            val lim = limit ?: return null
            if (isFeatureLock) return null
            return "${used ?: lim} of $lim used this month"
        }

    val recommendation: String
        get() = requiredPlan?.let { "Upgrade to ${prettyPlan(it)} to keep going." }
            ?: "Upgrade your plan to keep going."

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        fun decode(body: String): PlanGateError? =
            runCatching { json.decodeFromString<PlanGateError>(body) }.getOrNull()
                ?.takeIf { it.error != null }

        fun capLabel(cap: String?): String = when (cap) {
            "activeListings" -> "active-listings"
            "aiActions" -> "AI-actions"
            "includedGrades" -> "monthly-grades"
            "marketplaces" -> "marketplace"
            "teamSeats" -> "team-seat"
            else -> "plan"
        }

        fun prettyPlan(plan: String): String =
            plan.replaceFirstChar { it.uppercaseChar() }
    }
}

/** Parsed `X-Plan-Warning: CAP_80;kind=…;used=…;limit=…` header. */
data class PlanWarning(val kind: String, val used: Int, val limit: Int) {
    companion object {
        /** Null for an unrecognized shape — a malformed header is ignored. */
        fun parse(header: String): PlanWarning? {
            val fields = header.split(';')
                .mapNotNull { part ->
                    val kv = part.split('=', limit = 2).map { it.trim() }
                    if (kv.size == 2) kv[0] to kv[1] else null
                }
                .toMap()
            val kind = fields["kind"] ?: return null
            val used = fields["used"]?.toIntOrNull() ?: return null
            val limit = fields["limit"]?.toIntOrNull() ?: return null
            return PlanWarning(kind, used, limit)
        }
    }
}

/**
 * Shared emission point (iOS PlanGateNotifier): [EdgeApi] publishes here; the
 * billing/upgrade UI collects. Extra-buffered so an emission during a burst
 * never suspends the network path.
 */
object PlanGateNotifier {
    private val gatesFlow = MutableSharedFlow<PlanGateError>(extraBufferCapacity = 8)
    private val warningsFlow = MutableSharedFlow<PlanWarning>(extraBufferCapacity = 8)

    val gates: SharedFlow<PlanGateError> = gatesFlow
    val warnings: SharedFlow<PlanWarning> = warningsFlow

    fun publish(gate: PlanGateError) {
        gatesFlow.tryEmit(gate)
    }

    fun publishWarning(warning: PlanWarning) {
        warningsFlow.tryEmit(warning)
    }
}
