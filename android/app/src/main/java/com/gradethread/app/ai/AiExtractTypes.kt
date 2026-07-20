package com.gradethread.app.ai

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * US-1334: the wire contract for `POST /api/flipdesk/ai/extract`.
 *
 * **Field-name keys are preserved verbatim.** `suggestions`, `attributes`
 * and `measurements` are maps whose KEYS are inventory field names
 * (`garment_category`, `condition_notes`, …). A global snake_case naming
 * strategy would rewrite those keys and silently break every lookup, so this
 * module uses a bare [json] with no key transformation and spells out each
 * envelope key with an explicit [SerialName]. Do not "tidy" this by adding a
 * naming strategy.
 */
internal val aiExtractJson = Json {
    ignoreUnknownKeys = true
    isLenient = true
    explicitNulls = false
    encodeDefaults = true
}

@Serializable
data class FieldSuggestion(
    val value: String,
    val confidence: Double,
    val source: String,
)

/** US-821: always an array; `features` is the only multi-valued attribute. */
@Serializable
data class AttributeSuggestion(
    val values: List<String> = emptyList(),
    val confidence: Double = 0.0,
    val source: String = "",
)

@Serializable
data class FieldConflict(
    val field: String,
    @SerialName("text_value") val textValue: String? = null,
    @SerialName("photo_value") val photoValue: String? = null,
)

@Serializable
data class ResearchIdentification(
    @SerialName("identified_style") val identifiedStyle: String? = null,
    @SerialName("product_line") val productLine: String? = null,
    @SerialName("fabric_technology") val fabricTechnology: String? = null,
    @SerialName("msrp_estimate_cents") val msrpEstimateCents: Int? = null,
    @SerialName("identification_rationale") val rationale: String? = null,
    @SerialName("identification_confidence") val confidence: Double = 0.0,
)

@Serializable
data class AiExtractResponse(
    val suggestions: Map<String, FieldSuggestion> = emptyMap(),
    val attributes: Map<String, AttributeSuggestion> = emptyMap(),
    val conflicts: List<FieldConflict> = emptyList(),
    val measurements: Map<String, Double>? = null,
    @SerialName("condition_summary") val conditionSummary: String? = null,
    @SerialName("ebay_category_query") val ebayCategoryQuery: String? = null,
    val research: ResearchIdentification? = null,
    val model: String? = null,
    @SerialName("log_id") val logId: String? = null,
    @SerialName("actions_remaining") val actionsRemaining: Int = ACTIONS_REMAINING_UNKNOWN,
    /**
     * The server resolves the eBay category in a fire-and-forget background
     * pass, so this is true while it is still working.
     *
     * Deliberate divergence: iOS still decodes an `ebay` block and builds a
     * category summary from it, but the server now returns `ebay: null`
     * unconditionally — that phase moved to the background because it was a
     * second ~20s model call that doubled latency. The iOS path is dead code.
     * We decode `ebay_pending` and show a "resolving category" hint instead,
     * rather than porting a branch that can never fire.
     */
    @SerialName("ebay_pending") val ebayPending: Boolean = false,
    /** Attributes the server already gap-filled onto the item; iOS ignores these. */
    @SerialName("persisted_attributes") val persistedAttributes: Map<String, String> = emptyMap(),
) {
    companion object {
        /**
         * "Quota unknown" — no server call happened at all (the offline OCR
         * fallback synthesizes a response). Distinct from -1, which means
         * genuinely unlimited.
         */
        const val ACTIONS_REMAINING_UNKNOWN: Int = Int.MIN_VALUE
        const val ACTIONS_REMAINING_UNLIMITED: Int = -1
    }
}

@Serializable
data class AiExtractPhoto(val url: String, val type: String? = null)

@Serializable
data class AiExtractRequest(
    @SerialName("item_id") val itemId: String? = null,
    val photos: List<AiExtractPhoto> = emptyList(),
    /** Server DELETES these keys from the result so the AI can't contradict them. */
    @SerialName("known_fields") val knownFields: Map<String, String>? = null,
    val text: String? = null,
)

/** Body of `PATCH /api/flipdesk/ai/log/:id` — the acceptance feedback signal. */
@Serializable
data class AiCorrection(val suggested: String, val final: String)

@Serializable
data class AiLogFeedback(
    @SerialName("accepted_fields") val acceptedFields: Map<String, String>? = null,
    @SerialName("corrected_fields") val correctedFields: Map<String, AiCorrection>? = null,
)

/**
 * One renderable suggestion row.
 *
 * [displayLabel] and [sourceLabel] mirror the iOS strings exactly — these are
 * user-visible and the two clients should not word the same state differently.
 */
data class FieldSuggestionEntry(
    val field: String,
    val suggestion: FieldSuggestion,
) {
    /**
     * `this.field` is NOT redundant: inside a property accessor, bare `field`
     * is Kotlin's backing-field keyword, so it shadows the constructor
     * property of the same name and fails to compile against a property that
     * has no backing field. The name matches iOS, so the qualifier stays.
     */
    val displayLabel: String
        get() = this.field.split("_").joinToString(" ") { token ->
            if (token.isEmpty()) token else token.take(1).uppercase() + token.drop(1)
        }

    val sourceLabel: String
        get() = when {
            suggestion.source == "text" -> "From description"
            suggestion.source == "live-text" -> "On-device OCR"
            suggestion.source == "research" -> "Identified from product knowledge"
            suggestion.source == "conflict:tag" -> "Tag value — conflicts with photo"
            suggestion.source == "conflict:photo" -> "Photos disagree on this — verify"
            suggestion.source.startsWith("photo:") ->
                "From ${suggestion.source.removePrefix("photo:")} photo"
            else -> suggestion.source
        }

    /** Only research rows earn the "Identified" badge. */
    val isResearch: Boolean get() = suggestion.source == "research"

    /** Clamped defensively — a bad confidence must not produce a negative bar width. */
    val clampedConfidence: Double get() = suggestion.confidence.coerceIn(0.0, 1.0)
}
