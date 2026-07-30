package com.gradethread.app.passport

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/**
 * US-1376 (iOS `PassportTypes`): the PII-free provenance chain from
 * `GET /api/passport/{slug}`.
 *
 * The edge sanitizes everything before it leaves: actors are pseudonymous
 * labels unless the owner opted in per hop, and no user id or email is ever in
 * the payload. This client renders what it is given and never reaches for
 * identity — the privacy promise is the edge's, and the way to keep it is to
 * have nothing here that could break it.
 */
@Serializable
data class PassportTimeline(
    val slug: String = "",
    /** Free-form garment descriptor; only its string fields are read. */
    @SerialName("sku_class") val skuClass: JsonObject = JsonObject(emptyMap()),
    val status: String = "active",
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("origin_verified_seller") val originVerifiedSeller: PassportVerifiedSeller? = null,
    val events: List<PassportEvent> = emptyList(),
)

/** One hop on the chain. */
@Serializable
data class PassportEvent(
    @SerialName("event_type") val eventType: String = "unknown",
    val confidence: String = "unknown",
    /** Pseudonymous label such as "Seller A", or null for an actor-less hop. */
    val actor: String? = null,
    /** The actor's PUBLIC identity, present only when they opted in for this hop. */
    @SerialName("actor_revealed") val actorRevealed: PassportVerifiedSeller? = null,
    val source: String? = null,
    val payload: PassportEventPayload = PassportEventPayload(),
    @SerialName("created_at") val createdAt: String = "",
) {
    /**
     * Stable list key.
     *
     * The ledger is append-only, so type + timestamp + actor is unique enough;
     * the index the caller adds disambiguates two hops recorded in the same
     * instant.
     */
    val key: String get() = "$eventType|$createdAt|${actor.orEmpty()}"
}

/** The subset of a sanitized payload this surface shows. */
@Serializable
data class PassportEventPayload(
    @SerialName("overall_score") val overallScore: Double? = null,
    @SerialName("grade_tier") val gradeTier: String? = null,
    val certificate: String? = null,
)

/** A public, opt-in Verified profile. Handle and display name only. */
@Serializable
data class PassportVerifiedSeller(
    val handle: String = "",
    @SerialName("display_name") val displayName: String? = null,
    val since: String? = null,
)

/**
 * The confidence taxonomy, mirroring `src/lib/passport-confidence.ts` and the
 * `garment_event_confidence` enum. Exactly three levels.
 *
 * The wording is deliberately measured. "Probable" and "unknown" never say
 * confirmed or guaranteed, because a passport is a provenance claim someone
 * may rely on when paying, and overstating a link is the one failure that
 * matters here.
 */
enum class PassportConfidence(val label: String, val explanation: String) {
    DETERMINISTIC(
        "Verified",
        "Established by a first-party fact — a physical tag scan, an owner-confirmed " +
            "claim handoff, marketplace order lineage, or the original grade itself.",
    ),
    PROBABLE(
        "Probable",
        "Inferred from a visual fingerprint or reused-photo match. A likely link in " +
            "the chain, not an independently verified one.",
    ),
    UNKNOWN(
        "Unverified",
        "The basis for this link isn't independently verified (for example, a " +
            "self-declared origin).",
    ),
    ;

    companion object {
        /** Anything unrecognized reads as UNKNOWN, never as verified. */
        fun of(raw: String?): PassportConfidence = when (raw) {
            "deterministic" -> DETERMINISTIC
            "probable" -> PROBABLE
            else -> UNKNOWN
        }
    }
}

/** How many hops are proven versus inferred. Mirrors the web `chainStrength()`. */
data class PassportChainStrength(
    val total: Int,
    val deterministic: Int,
    val probable: Int,
    val unknown: Int,
    /** Fraction of links that are deterministic, 0..1. */
    val score: Double,
    val label: String,
    val summary: String,
) {
    companion object {
        fun of(confidences: List<String?>): PassportChainStrength {
            var det = 0
            var prob = 0
            var unk = 0
            for (raw in confidences) {
                when (PassportConfidence.of(raw)) {
                    PassportConfidence.DETERMINISTIC -> det++
                    PassportConfidence.PROBABLE -> prob++
                    PassportConfidence.UNKNOWN -> unk++
                }
            }
            val total = confidences.size
            val score = if (total == 0) 0.0 else det.toDouble() / total
            return PassportChainStrength(
                total = total,
                deterministic = det,
                probable = prob,
                unknown = unk,
                score = score,
                label = when {
                    total == 0 -> "None"
                    score >= 0.75 -> "Strong"
                    score >= 0.4 -> "Moderate"
                    else -> "Emerging"
                },
                summary = if (total == 0) {
                    "No history recorded yet."
                } else {
                    // Counts, not an adjective on its own: "3 of 5 verified" is
                    // checkable, "moderate" is a word somebody has to trust.
                    "$det of $total ${if (total == 1) "link is" else "links are"} " +
                        "independently verified."
                },
            )
        }
    }
}

object PassportFormat {

    /**
     * Human label per event type, mirroring the web `EVENT_META`.
     *
     * `authenticity_assessed` is here on purpose: the enum gained it in
     * migration 00488 and the iOS map still doesn't have it, so that event
     * falls through to a generic title-cased label there.
     */
    fun eventLabel(eventType: String): String = when (eventType) {
        "graded" -> "Condition graded"
        "listed" -> "Listed for sale"
        "sold" -> "Sold"
        "ownership_transfer" -> "Ownership transferred"
        "fingerprinted" -> "Fingerprinted"
        "authenticity_assessed" -> "Authenticity assessed"
        // A future enum value renders as itself rather than as "Unknown", which
        // would hide a real event behind a word that means nothing happened.
        else -> titleCase(eventType)
    }

    /** "ownership_transfer" / "very-good" → "Ownership Transfer" / "Very Good". */
    fun titleCase(value: String): String = value
        .split('-', '_')
        .filter { it.isNotEmpty() }
        .joinToString(" ") { it.replaceFirstChar { c -> c.uppercaseChar() } }

    /** A human garment name from the PII-free descriptor. */
    fun garmentName(skuClass: JsonObject): String {
        val brand = string(skuClass, "brand")
        val type = string(skuClass, "garment_type")?.let { titleCase(it) }
        val parts = listOfNotNull(brand, type)
        return if (parts.isEmpty()) "Graded garment" else parts.joinToString(" ")
    }

    private fun string(obj: JsonObject, key: String): String? =
        (obj[key] as? JsonPrimitive)
            ?.takeIf { it.isString }
            ?.content
            ?.trim()
            ?.takeIf { it.isNotEmpty() }

    /**
     * ISO timestamp to a readable date, falling back to the raw string.
     *
     * Never blank on a parse failure: showing the raw timestamp is ugly but
     * still tells the reader when something happened, which an empty line does
     * not.
     */
    fun longDate(iso: String): String {
        if (iso.isBlank()) return ""
        return runCatching {
            OffsetDateTime.parse(iso)
                .format(DateTimeFormatter.ofLocalizedDate(FormatStyle.LONG).withLocale(Locale.getDefault()))
        }.getOrElse { iso }
    }

    /** Sort key for chronological ordering; unparseable timestamps sink. */
    fun epochMillis(iso: String): Long =
        runCatching { OffsetDateTime.parse(iso).toInstant().toEpochMilli() }
            .getOrDefault(Long.MAX_VALUE)

    /**
     * Chronological order, oldest first.
     *
     * The edge already orders these, but it also CACHES the assembled body, and
     * a timeline that renders out of order tells a false story about what
     * happened to a garment. Sorting again costs nothing.
     */
    fun ordered(events: List<PassportEvent>): List<PassportEvent> =
        events.sortedBy { epochMillis(it.createdAt) }

    /** The grade line on a `graded` hop, or null when it carries none. */
    fun gradeLine(event: PassportEvent): String? {
        val score = event.payload.overallScore ?: return null
        val tier = event.payload.gradeTier?.takeIf { it.isNotBlank() }?.let { " · ${titleCase(it)}" }
        return String.format(Locale.US, "%.1f", score) + tier.orEmpty()
    }

    /**
     * Who did it.
     *
     * A revealed handle wins, then the pseudonymous label, then nothing —
     * inventing "Unknown seller" for an actor-less hop would imply a person was
     * involved when the ledger says otherwise.
     */
    fun actorLine(event: PassportEvent): String? {
        event.actorRevealed?.let { revealed ->
            val name = revealed.displayName?.takeIf { it.isNotBlank() } ?: "@${revealed.handle}"
            return "$name (verified)"
        }
        return event.actor?.takeIf { it.isNotBlank() }
    }
}
