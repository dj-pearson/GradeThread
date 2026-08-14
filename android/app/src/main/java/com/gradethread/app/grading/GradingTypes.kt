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
data class GradingRequestItem(@SerialName("inventory_item_id") val inventoryItemId: String, val tier: String)

@Serializable
data class GradingRequestBody(
    val items: List<GradingRequestItem>,
    /**
     * US-2564: the charge token for THIS bulk submit.
     *
     * Grading is billed per garment and the edge keys its credit debit on
     * `batch_key` + item id, so a retried batch charges once per garment rather
     * than once per attempt. Null for the single-item paths, which the edge
     * treats exactly as it did before this field existed — an empty string would
     * be a real key shared by every keyless caller, which is why the absent case
     * is null and not "".
     */
    @SerialName("batch_key") val batchKey: String? = null,
) {
    companion object {
        fun single(inventoryItemId: String, tier: GradeTier) =
            GradingRequestBody(listOf(GradingRequestItem(inventoryItemId, tier.wire)))

        /**
         * US-1339: the batch variant. Capped at [MAX_BATCH] because the edge's
         * schema rejects a larger array outright — sending 201 items fails all
         * 201, so the cap is applied here rather than discovered as a 400.
         */
        fun batch(inventoryItemIds: List<String>, tier: GradeTier): GradingRequestBody {
            val capped = inventoryItemIds.take(MAX_BATCH)
            return GradingRequestBody(
                capped.map { GradingRequestItem(it, tier.wire) },
                // Derived from the CAPPED list, so the token describes the batch
                // that is actually sent rather than the one the user selected.
                batchKey = bulkBatchKey(capped, tier.wire),
            )
        }

        /** `submitBodySchema` in flipdesk-grading.ts: `.max(200)`. */
        const val MAX_BATCH = 200

        /**
         * US-2564: a stable, bounded charge token for (selection, tier).
         *
         * Mirrors `src/lib/bulk-batch-key.ts` on web, deliberately down to the
         * constants: the two clients do not need to agree on the VALUE (each
         * only dedupes against its own retries), but they do need to agree on
         * the BEHAVIOUR, or the same user action means different things
         * depending on which app they used.
         *
         * Deterministic rather than a fresh UUID, because a UUID per attempt is
         * the defect — a failed submit is the thing a seller retries hardest, and
         * a new token on each press makes every retry a fresh set of charges.
         * Order-insensitive, since the same garments picked in a different order
         * are the same batch.
         *
         * The ids are DIGESTED, not carried: joining 200 UUIDs is ~7.4 KB and the
         * edge's `.strict()` schema caps `batch_key` at 255 characters. FNV-1a is
         * not cryptographic and does not need to be — nothing here is secret.
         * Two independently-seeded passes plus the item count give enough
         * discrimination that two different selections never share a token, which
         * matters because a collision would silently drop a garment from a batch.
         *
         * `Char.code` is a UTF-16 code unit, matching JS `charCodeAt`, and `Int`
         * multiplication wraps at 32 bits, matching `Math.imul`.
         */
        fun bulkBatchKey(inventoryItemIds: List<String>, tier: String): String? {
            if (inventoryItemIds.isEmpty()) return null
            val canonical = "$tier|" + inventoryItemIds.sorted().joinToString(",")
            return listOf(
                "fdbulk",
                inventoryItemIds.size.toString(),
                hex32(fnv1a(canonical, FNV_OFFSET_BASIS)),
                hex32(fnv1a(canonical, GOLDEN_RATIO_SEED)),
            ).joinToString("-")
        }

        /** FNV-1a 32-bit offset basis — the algorithm's own published constant. */
        private const val FNV_OFFSET_BASIS: Int = -0x7EE3623B // 0x811C9DC5

        /** FNV-1a 32-bit prime — likewise. */
        private const val FNV_PRIME: Int = 0x01000193

        /** A second, independent seed so the two passes cannot agree by accident. */
        private const val GOLDEN_RATIO_SEED: Int = -0x61C88647 // 0x9E3779B9
        private const val HEX_WIDTH = 8
        private const val HEX_RADIX = 16
        private const val U32_MASK = 0xFFFFFFFFL

        private fun fnv1a(input: String, seed: Int): Int {
            var hash = seed
            for (ch in input) {
                hash = hash xor ch.code
                hash *= FNV_PRIME
            }
            return hash
        }

        private fun hex32(value: Int): String =
            (value.toLong() and U32_MASK).toString(HEX_RADIX).padStart(HEX_WIDTH, '0')
    }
}
