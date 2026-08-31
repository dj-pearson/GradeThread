package com.gradethread.app.grading

import androidx.annotation.StringRes
import com.gradethread.app.R

/**
 * US-1336: the three certified-grade tiers (iOS `GradeTierOption`).
 *
 * [creditCost] mirrors `TIER_CREDIT_COST` in the edge's grade-pricing.ts. It is
 * shown, never enforced: the server charges, and validate/submit are the only
 * authority on affordability. A client that decided for itself would drift the
 * moment pricing_config is edited from admin (US-885).
 */
enum class GradeTier(
    val wire: String,
    @StringRes val label: Int,
    @StringRes val turnaround: Int,
    val creditCost: Int,
    @StringRes val blurb: Int,
) {
    STANDARD(
        wire = "standard",
        label = R.string.grade_tier_standard,
        turnaround = R.string.grade_tier_standard_turnaround,
        creditCost = 1,
        blurb = R.string.grade_tier_standard_blurb,
    ),
    PREMIUM(
        wire = "premium",
        label = R.string.grade_tier_premium,
        turnaround = R.string.grade_tier_premium_turnaround,
        creditCost = 3,
        blurb = R.string.grade_tier_premium_blurb,
    ),
    EXPRESS(
        wire = "express",
        label = R.string.grade_tier_express,
        turnaround = R.string.grade_tier_express_turnaround,
        creditCost = 5,
        blurb = R.string.grade_tier_express_blurb,
    ),
    ;

    companion object {
        val default: GradeTier = STANDARD

        fun fromWire(value: String?): GradeTier = entries.firstOrNull { it.wire == value } ?: default
    }
}
