package com.gradethread.app.inventory

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.text.NumberFormat
import java.util.Locale

/**
 * US-1345: the canonical measurement keys.
 *
 * Mirrors `src/lib/measurements.ts` and the iOS `MeasurementCatalog`. Values
 * live on `inventory_items.measurements` (jsonb) keyed by these strings —
 * LENGTH is flat inches, shoe sizes are US numeric, watch dimensions are
 * millimetres. Pure data with no behaviour to drift.
 */
object MeasurementCatalog {

    enum class Kind(val unit: String) {
        LENGTH("in"),
        SHOE("US"),
        MM("mm"),
    }

    data class Spec(val key: String, val label: String, val kind: Kind)

    /** Canonical key → spec, in render order. */
    val specs: List<Spec> = listOf(
        Spec("chest", "Chest (pit to pit)", Kind.LENGTH),
        Spec("bust", "Bust", Kind.LENGTH),
        Spec("waist", "Waist (flat)", Kind.LENGTH),
        Spec("hip", "Hip", Kind.LENGTH),
        Spec("inseam", "Inseam", Kind.LENGTH),
        Spec("rise", "Front rise", Kind.LENGTH),
        Spec("leg_opening", "Leg opening", Kind.LENGTH),
        Spec("sleeve", "Sleeve", Kind.LENGTH),
        Spec("shoulder", "Shoulder", Kind.LENGTH),
        Spec("length", "Length", Kind.LENGTH),
        Spec("width", "Width", Kind.LENGTH),
        Spec("insole", "Insole length", Kind.LENGTH),
        Spec("size_us", "US size", Kind.SHOE),
        // US-2812: bags, belts and headwear. These existed on the web and in
        // no native catalog, so suggestedKeys could not offer them and a key
        // arriving from the server rendered with an auto-derived label.
        Spec("height", "Height", Kind.LENGTH),
        Spec("depth", "Depth", Kind.LENGTH),
        Spec("strap_drop", "Strap drop", Kind.LENGTH),
        Spec("handle_drop", "Handle drop", Kind.LENGTH),
        Spec("hole_span", "First to last hole (belts)", Kind.LENGTH),
        Spec("circumference", "Head circumference (inside)", Kind.LENGTH),
        Spec("crown_height", "Crown height", Kind.LENGTH),
        Spec("brim_length", "Brim length", Kind.LENGTH),
        Spec("case_diameter", "Case diameter", Kind.MM),
        Spec("lug_width", "Lug width", Kind.MM),
        Spec("band_length", "Band length", Kind.MM),
    )

    private val byKey: Map<String, Spec> = specs.associateBy { it.key }

    /**
     * US-1353: the eBay aspect names each measurement can fill, in preference
     * order — the `aspects` arrays of `MEASUREMENT_SPECS` in
     * `services/edge-functions/src/lib/measurements.ts`.
     *
     * The edge fills these itself at publish (`resolveMeasurementAspects`), so
     * this list is not a second writer. It is here so the specifics editor can
     * SAY which blanks the publish will fill from the measurements already on
     * the item, instead of showing them as gaps the seller has to type twice.
     */
    val aspectCandidates: Map<String, List<String>> = mapOf(
        "chest" to listOf("Chest Size", "Chest", "Pit to Pit"),
        "bust" to listOf("Bust", "Bust Size"),
        "waist" to listOf("Waist Size", "Waist"),
        "hip" to listOf("Hip Size", "Hip", "Hips"),
        "inseam" to listOf("Inseam", "Inseam Length"),
        "rise" to listOf("Rise", "Front Rise"),
        "leg_opening" to listOf("Leg Opening", "Hem Width"),
        "sleeve" to listOf("Sleeve Length", "Sleeve"),
        "shoulder" to listOf("Shoulder Width", "Shoulder to Shoulder", "Shoulder"),
        "length" to listOf("Length", "Garment Length", "Total Length"),
        "width" to listOf("Width"),
        "insole" to listOf("Insole Length", "Insole"),
        "size_us" to listOf("US Shoe Size", "Shoe Size"),
        "case_diameter" to listOf("Case Diameter", "Case Size"),
        "lug_width" to listOf("Lug Width"),
        "band_length" to listOf("Band Length", "Strap Length"),
    )

    /**
     * US-1353: one measurement as eBay will see it — `"20 in"`, `"US 10"`,
     * `"42 mm"` (edge `formatMeasurementValue`).
     *
     * Locale.US and never the editing formatter: this is a value published to a
     * marketplace, not a number being typed. A German locale's "20,5 in" is not
     * what the server would send, and showing it would misreport the listing.
     */
    fun publishValue(key: String, value: Double): String? {
        if (!value.isFinite() || value <= 0.0) return null
        val rounded = Math.round(value * 100) / 100.0
        val number = if (rounded % 1.0 == 0.0) {
            rounded.toLong().toString()
        } else {
            String.format(Locale.US, "%s", rounded)
        }
        return when (kind(key)) {
            Kind.SHOE -> "US $number"
            Kind.MM -> "$number mm"
            Kind.LENGTH -> "$number in"
        }
    }

    /** Human label; a non-canonical key de-underscores rather than vanishing. */
    fun label(key: String): String = byKey[key]?.label
        ?: key.split("_").joinToString(" ") { part ->
            part.replaceFirstChar { it.uppercase() }
        }

    /** Unknown keys are treated as lengths — overwhelmingly the common case. */
    fun kind(key: String): Kind = byKey[key]?.kind ?: Kind.LENGTH

    /**
     * The keys worth offering first for a coarse item category.
     *
     * US-2812: mirrors MEASUREMENT_TEMPLATES in
     * src/lib/measurement-templates.ts, which this had silently drifted from.
     * `bags` and `accessories` shared a branch returning length+width, and
     * there was no `headwear` branch at all — so a hat fell to the clothing
     * default and was offered a chest, a sleeve and an INSEAM. That was
     * harmless until US-2797 made `headwear` a producible item_category;
     * before it, no item could carry the value.
     *
     * CLOTHING STAYS ONE FLAT LIST, deliberately. The web splits it five ways
     * (top/bottom/dress/outerwear/suit) by resolving a GARMENT word, and this
     * function only has the coarse item_category — `clothing` cannot tell a
     * blazer from jeans. Offering the union is the honest answer here; a
     * parity guard that demanded the web's five groups would be demanding
     * information this caller does not have.
     */
    fun suggestedKeys(category: String?): List<String> =
        when (category?.lowercase()) {
            "shoes", "footwear" -> listOf("size_us", "insole")
            "watches", "watch" -> listOf("case_diameter", "lug_width", "band_length")
            "bags" -> listOf("width", "height", "depth", "strap_drop", "handle_drop")
            "accessories" -> listOf("length", "width", "hole_span")
            "headwear" -> listOf("circumference", "crown_height", "brim_length")
            "other" -> listOf("length", "width")
            // Clothing and anything uncategorized.
            else -> listOf("chest", "length", "shoulder", "sleeve", "waist", "inseam", "rise", "hip")
        }

    /** Canonical keys in catalog order first, then extras alphabetically. */
    fun ordered(keys: Collection<String>): List<String> {
        val present = keys.toSet()
        val canonical = specs.map { it.key }.filter { it in present }
        return canonical + (present - canonical.toSet()).sorted()
    }

    // ── Locale-safe text round trip (the iOS US-1491 lesson) ─────────────

    /**
     * The editing formatter.
     *
     * Locale-aware in both directions, and that is not cosmetic: iOS shipped a
     * raw `Double(text)` parse that returned null for "18,5" in de/fr/es, and a
     * "."-formatted display that re-parsed as a GROUPING separator — so 18.5
     * became 185. Grouping is disabled here for exactly that reason.
     */
    private fun formatter(locale: Locale): NumberFormat =
        NumberFormat.getNumberInstance(locale).apply {
            isGroupingUsed = false
            maximumFractionDigits = 2
            minimumFractionDigits = 0
        }

    /** Display a stored value; empty for unset or non-positive. */
    fun editableString(value: Double?, locale: Locale = Locale.getDefault()): String {
        if (value == null || value <= 0.0) return ""
        return formatter(locale).format(value)
    }

    /** Parse typed text with the locale's decimal separator. */
    fun parse(input: String, locale: Locale = Locale.getDefault()): Double? {
        val trimmed = input.trim()
        if (trimmed.isEmpty()) return null
        return runCatching { formatter(locale).parse(trimmed)?.toDouble() }
            .getOrNull()
            ?.takeIf { it.isFinite() && it > 0.0 }
    }

    // ── jsonb round trip ─────────────────────────────────────────────────

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    /**
     * Decode the stored `measurements` document.
     *
     * Non-numeric and non-positive entries are dropped rather than surfaced: a
     * measurement of 0 or "unknown" is not a measurement, and showing it as one
     * would put a false number in a buyer-facing listing.
     */
    fun decode(raw: String?): Map<String, Double> {
        if (raw.isNullOrBlank()) return emptyMap()
        return runCatching {
            json.parseToJsonElement(raw).let { it as? JsonObject }
                ?.mapNotNull { (key, value) ->
                    val number = value.jsonPrimitive.doubleOrNull
                    if (number != null && number > 0.0) key to number else null
                }
                ?.toMap()
                .orEmpty()
        }.getOrDefault(emptyMap())
    }

    /** Encode for the jsonb column; null when there is nothing to store. */
    fun encode(measurements: Map<String, Double>): String? {
        val kept = measurements.filterValues { it > 0.0 }
        if (kept.isEmpty()) return null
        return JsonObject(
            ordered(kept.keys).associateWith { JsonPrimitive(kept.getValue(it)) },
        ).toString()
    }
}
