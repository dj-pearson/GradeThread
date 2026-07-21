package com.gradethread.app.grading

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
    val label: String,
    val turnaround: String,
    val creditCost: Int,
    val blurb: String,
) {
    STANDARD(
        wire = "standard",
        label = "Standard",
        turnaround = "~48 hr",
        creditCost = 1,
        blurb = "Full certified grade. Included with your plan.",
    ),
    PREMIUM(
        wire = "premium",
        label = "Premium",
        turnaround = "~12 hr",
        creditCost = 3,
        blurb = "Faster queue for time-sensitive listings.",
    ),
    EXPRESS(
        wire = "express",
        label = "Express",
        turnaround = "~1 hr",
        creditCost = 5,
        blurb = "Top-priority — graded within the hour.",
    ),
    ;

    companion object {
        val default: GradeTier = STANDARD

        fun fromWire(value: String?): GradeTier =
            entries.firstOrNull { it.wire == value } ?: default
    }
}
