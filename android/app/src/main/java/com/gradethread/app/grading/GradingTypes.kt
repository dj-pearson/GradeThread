package com.gradethread.app.grading

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * US-1336: the wire contract for the FlipDesk → GradeThread grading bridge
 * under `/api/flipdesk/grading` (validate, submit, submissions).
 *
 * Note the path is spelled without a trailing wildcard on purpose: Kotlin
 * block comments NEST, so a literal slash-star inside this KDoc opens a second
 * comment and the closing star-slash only closes THAT one — silently swallowing
 * the rest of the file.
 *
 * Keys are spelled out rather than derived. The REQUEST side is why: the edge
 * validates it with a `.strict()` Zod schema, so a single unexpected key —
 * including a null a naming strategy happened to emit — is a 400 for the whole
 * submission, not a field quietly ignored.
 */
internal val gradingJson = Json {
    ignoreUnknownKeys = true
    isLenient = true
    explicitNulls = false
}

// ── /validate ────────────────────────────────────────────────────────────

@Serializable
data class GradingUserInfo(
    val plan: String = "free",
    @SerialName("grades_used_this_month") val gradesUsedThisMonth: Int = 0,
    @SerialName("plan_limit") val planLimit: Int = 0,
    /** Included remaining + credits — the "grades left" the picker shows. */
    @SerialName("grades_remaining") val gradesRemaining: Int = 0,
    @SerialName("included_remaining") val includedRemaining: Int = 0,
    @SerialName("credit_balance") val creditBalance: Int = 0,
)

@Serializable
data class GradingValidatedItem(
    @SerialName("inventory_item_id") val inventoryItemId: String = "",
    val tier: String = GradeTier.STANDARD.wire,
    val cost: Double = 0.0,
    val ready: Boolean = false,
    /** Human-readable reasons this item can't be graded yet. */
    val blockers: List<String> = emptyList(),
    val title: String? = null,
    @SerialName("garment_type") val garmentType: String? = null,
    @SerialName("garment_category") val garmentCategory: String? = null,
    @SerialName("required_photo_types_missing")
    val requiredPhotoTypesMissing: List<String> = emptyList(),
)

@Serializable
data class GradingValidateResponse(
    val user: GradingUserInfo = GradingUserInfo(),
    val items: List<GradingValidatedItem> = emptyList(),
    @SerialName("total_cost") val totalCost: Double = 0.0,
    @SerialName("credits_required") val creditsRequired: Int = 0,
    @SerialName("can_submit") val canSubmit: Boolean = false,
    /** The credit balance can't cover [creditsRequired] — the top-up trigger. */
    @SerialName("limit_exceeded") val limitExceeded: Boolean = false,
) {
    /** The reseller grades one item at a time from its canvas. */
    val item: GradingValidatedItem? get() = items.firstOrNull()
}

// ── /submit ──────────────────────────────────────────────────────────────

@Serializable
data class GradingSubmitResult(
    val ok: Boolean = false,
    @SerialName("inventory_item_id") val inventoryItemId: String = "",
    @SerialName("submission_id") val submissionId: String? = null,
    /** The bridge row id — this is what the status poll is keyed on. */
    @SerialName("flipdesk_grading_submission_id")
    val flipdeskGradingSubmissionId: String? = null,
    val tier: String? = null,
    val cost: Double? = null,
    val error: String? = null,
)

@Serializable
data class GradingSubmitResponse(
    val submitted: Int = 0,
    val failed: Int = 0,
    val results: List<GradingSubmitResult> = emptyList(),
)

// ── /submissions/:id ─────────────────────────────────────────────────────

@Serializable
data class GradeReportDto(
    val id: String = "",
    @SerialName("overall_score") val overallScore: Double = 0.0,
    @SerialName("grade_tier") val gradeTier: String = "",
    @SerialName("fabric_condition_score") val fabricConditionScore: Double = 0.0,
    @SerialName("structural_integrity_score") val structuralIntegrityScore: Double = 0.0,
    @SerialName("cosmetic_appearance_score") val cosmeticAppearanceScore: Double = 0.0,
    @SerialName("functional_elements_score") val functionalElementsScore: Double = 0.0,
    @SerialName("odor_cleanliness_score") val odorCleanlinessScore: Double = 0.0,
    @SerialName("ai_summary") val aiSummary: String = "",
    @SerialName("confidence_score") val confidenceScore: Double = 0.0,
    @SerialName("certificate_id") val certificateId: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
)

@Serializable
data class GradingStatusItem(
    val title: String? = null,
    @SerialName("grade_value") val gradeValue: Double? = null,
    @SerialName("grade_label") val gradeLabel: String? = null,
    @SerialName("certificate_url") val certificateUrl: String? = null,
)

@Serializable
data class GradingStatusResponse(
    val id: String = "",
    @SerialName("inventory_item_id") val inventoryItemId: String = "",
    @SerialName("submission_id") val submissionId: String? = null,
    val tier: String = "",
    val status: String = "",
    val cost: Double = 0.0,
    @SerialName("submitted_at") val submittedAt: String? = null,
    @SerialName("graded_at") val gradedAt: String? = null,
    val error: String? = null,
    val item: GradingStatusItem = GradingStatusItem(),
    @SerialName("grade_report") val gradeReport: GradeReportDto? = null,
)

// ── Request bodies ───────────────────────────────────────────────────────

@Serializable
data class GradingRequestItem(
    @SerialName("inventory_item_id") val inventoryItemId: String,
    val tier: String,
)

@Serializable
data class GradingRequestBody(val items: List<GradingRequestItem>) {
    companion object {
        fun single(inventoryItemId: String, tier: GradeTier) =
            GradingRequestBody(listOf(GradingRequestItem(inventoryItemId, tier.wire)))
    }
}
