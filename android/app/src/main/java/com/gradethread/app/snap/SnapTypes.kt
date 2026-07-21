package com.gradethread.app.snap

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * US-1335: the wire contract for `POST /api/grade/snap` — the free,
 * signup-gated Snap-to-Value scan.
 *
 * **The response mixes two casings, and that is not a mistake to "tidy".**
 * The envelope is snake_case (`overall_score`, `grade_tier`), but the `value`
 * object comes straight from the comp engine and is already camelCase
 * (`lowCents`, `sampleSize`). iOS gets away with one `.convertFromSnakeCase`
 * decoder only because camelCase keys are unchanged by that transform. A
 * global snake_case naming strategy here would rewrite `lowCents` to
 * `low_cents` and silently null out the entire value range while still
 * parsing cleanly — so this module spells every key out explicitly.
 */
internal val snapJson = Json {
    ignoreUnknownKeys = true
    isLenient = true
    explicitNulls = false
}

@Serializable
data class SnapGrade(
    @SerialName("overall_score") val overallScore: Double,
    @SerialName("grade_tier") val gradeTier: String,
    val confidence: Double,
)

/** The condition-adjusted comp range. Absent when there was nothing to comp. */
@Serializable
data class SnapValue(
    val lowCents: Int? = null,
    val medianCents: Int? = null,
    val highCents: Int? = null,
    val sampleSize: Int = 0,
    val confidence: Double = 0.0,
    /** False when the comp set was too thin to quote — show the reason, not a range. */
    val sufficient: Boolean = false,
    val currency: String = "USD",
)

/**
 * US-952: the model's best-effort garment classification.
 *
 * Deliberate divergence: iOS does not decode this at all, so its "Get
 * certified grade" CTA hands off with nothing and the seller re-picks a
 * garment type the model already identified. Decoding it here costs nothing
 * and is what US-1336's certified-grade form will prefill from.
 */
@Serializable
data class SnapGarment(
    val type: String? = null,
    val category: String? = null,
)

@Serializable
data class SnapResponse(
    val grade: SnapGrade,
    val value: SnapValue? = null,
    val garment: SnapGarment? = null,
    val disclaimer: String = "",
)

@Serializable
data class SnapRequest(
    /** A `data:image/jpeg;base64,…` URI — the edge validates and EXIF-strips it. */
    val image: String,
    val brand: String? = null,
    val keyword: String? = null,
)
