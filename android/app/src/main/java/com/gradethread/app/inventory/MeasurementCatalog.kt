package com.gradethread.app.inventory

import androidx.annotation.StringRes
import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.text.NumberFormat
import java.util.Locale
import kotlin.math.abs
import kotlin.math.floor

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

    /**
     * A measurement key, what it is CALLED on the wire, and what the seller
     * reads.
     *
     * ⚠ [label] IS NOT DISPLAY COPY AND MUST NOT BE TRANSLATED. It is
     * persisted onto a calibration line and drawn into the overlay image the
     * BUYER sees - `formatInches(line.label, line.inches)` in
     * services/edge-functions/src/lib/measure-overlay.ts - and it is the key
     * the web matches on in src/lib/measurements.ts. A Spanish seller whose
     * client wrote "Pecho (de axila a axila)" here would publish a listing
     * photo captioned in a language the buyer did not choose.
     *
     * [display] is the same measurement in the seller's own language, and is
     * what every screen shows. US-2976 separated the two.
     */
    data class Spec(val key: String, val label: String, @StringRes val display: Int, val kind: Kind)

    /** Canonical key → spec, in render order. */
    val specs: List<Spec> = listOf(
        Spec("chest", "Chest (pit to pit)", R.string.measurement_chest, Kind.LENGTH),
        Spec("bust", "Bust", R.string.measurement_bust, Kind.LENGTH),
        Spec("waist", "Waist (flat)", R.string.measurement_waist, Kind.LENGTH),
        Spec("hip", "Hip", R.string.measurement_hip, Kind.LENGTH),
        Spec("inseam", "Inseam", R.string.measurement_inseam, Kind.LENGTH),
        Spec("rise", "Front rise", R.string.measurement_rise, Kind.LENGTH),
        Spec("leg_opening", "Leg opening", R.string.measurement_leg_opening, Kind.LENGTH),
        Spec("sleeve", "Sleeve", R.string.measurement_sleeve, Kind.LENGTH),
        Spec("shoulder", "Shoulder", R.string.measurement_shoulder, Kind.LENGTH),
        Spec("length", "Length", R.string.measurement_length, Kind.LENGTH),
        Spec("width", "Width", R.string.measurement_width, Kind.LENGTH),
        Spec("insole", "Insole length", R.string.measurement_insole, Kind.LENGTH),
        Spec("size_us", "US size", R.string.measurement_size_us, Kind.SHOE),
        // US-2812: bags, belts and headwear. These existed on the web and in
        // no native catalog, so suggestedKeys could not offer them and a key
        // arriving from the server rendered with an auto-derived label.
        Spec("height", "Height", R.string.measurement_height, Kind.LENGTH),
        Spec("depth", "Depth", R.string.measurement_depth, Kind.LENGTH),
        Spec("strap_drop", "Strap drop", R.string.measurement_strap_drop, Kind.LENGTH),
        Spec("handle_drop", "Handle drop", R.string.measurement_handle_drop, Kind.LENGTH),
        Spec("hole_span", "First to last hole (belts)", R.string.measurement_hole_span, Kind.LENGTH),
        Spec("circumference", "Head circumference (inside)", R.string.measurement_circumference, Kind.LENGTH),
        Spec("crown_height", "Crown height", R.string.measurement_crown_height, Kind.LENGTH),
        Spec("brim_length", "Brim length", R.string.measurement_brim_length, Kind.LENGTH),
        Spec("case_diameter", "Case diameter", R.string.measurement_case_diameter, Kind.MM),
        Spec("lug_width", "Lug width", R.string.measurement_lug_width, Kind.MM),
        Spec("band_length", "Band length", R.string.measurement_band_length, Kind.MM),
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
    /**
     * The WIRE label: persisted with a calibration line and drawn into the
     * buyer-facing overlay. See [Spec.label] - this one does not translate.
     */
    fun label(key: String): String = byKey[key]?.label ?: derive(key)

    /**
     * What the SELLER reads for this key.
     *
     * US-2976: a key this build has never seen still gets a name, derived from
     * the key itself, and that derived name arrives as `detail` - it is not
     * ours to translate and inventing a resource for it would be a lie.
     */
    fun display(key: String): UiMessage {
        val spec = byKey[key] ?: return UiMessage(R.string.measurement_unknown, detail = derive(key))
        return UiMessage(spec.display)
    }

    private fun derive(key: String): String = key.split("_").joinToString(" ") { part ->
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
    fun suggestedKeys(category: String?): List<String> = when (category?.lowercase()) {
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
    private fun formatter(locale: Locale): NumberFormat = NumberFormat.getNumberInstance(locale).apply {
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

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

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

/**
 * US-2921: does the size on the label agree with what the garment measures?
 *
 * The MATH is not here. `GET /api/flipdesk/size-bands` turns a brand's
 * body-measurement chart into the flat range a garment of each size should show
 * — adding garment ease and halving the circumference — and returns a small
 * table. This object does the LOOKUP against that table, which is what has to
 * run on every keystroke while somebody measures with one hand.
 *
 * It is a Kotlin copy of `src/lib/size-check.ts` and it runs the SAME two
 * fixture cases the edge, web and iOS suites run (`SizeCheckTest.kt`), so the
 * four copies cannot drift apart without a red test somewhere.
 *
 * Pure: no network, no state, no side effects.
 */
object SizeCheck {

    @Serializable
    data class BandRow(
        val size: String = "",
        val index: Int = 0,
        /** Measurement key → [low, high] expected FLAT inches. */
        val bands: Map<String, List<Double>> = emptyMap(),
    )

    @Serializable
    data class BandsResponse(
        val tier: String = "none",
        val brandLabel: String? = null,
        val department: String? = null,
        val garment: String? = null,
        val sourceUrl: String? = null,
        val sizeSystem: String? = null,
        val sizeClass: String? = null,
        val measurementBasis: String = "body",
        val rows: List<BandRow> = emptyList(),
    ) {
        companion object {
            /**
             * What every "we have nothing to say" path returns. A failed fetch
             * is not an error state here: the check is an assist, and a brand
             * with no chart on file looks exactly the same to the seller.
             */
            val EMPTY = BandsResponse()
        }
    }

    enum class Status { OK, OFF, UNKNOWN }

    data class Verdict(
        val status: Status,
        /** What the measurements point at ("XS", or "smaller than XS"). */
        val impliedSize: String?,
        /** Size steps between the label and the implied size. 0 when they agree. */
        val stepsOff: Int,
        /** The measurement driving the verdict. */
        val key: String?,
        /** The labelled size's own band for that key. */
        val expected: List<Double>?,
    ) {
        companion object {
            val UNKNOWN = Verdict(Status.UNKNOWN, null, 0, null, null)
        }
    }

    /** The keys a band can be built for, in the order they are judged. */
    val bandKeys = listOf("chest", "bust", "waist", "hip", "inseam")

    /**
     * Which item measurement answers a band key. A top's flat pit-to-pit is
     * stored as `chest` whatever the chart calls it; nothing else substitutes.
     */
    private val measurementAliases = mapOf(
        "chest" to listOf("chest", "bust"),
        "bust" to listOf("bust", "chest"),
        "waist" to listOf("waist"),
        "hip" to listOf("hip", "hips"),
        "inseam" to listOf("inseam"),
    )

    /**
     * Size steps required before a disagreement is worth saying out loud: one on
     * a chart a human checked against the brand's own guide, two on a generic
     * fallback that is an estimate and says so.
     */
    fun toleranceForTier(tier: String): Int = if (tier == "generic") 2 else 1

    // ── Matching a size label to a row ──────────────────────────────────────

    private val alphaWords = listOf(
        "extra extra extra" to "xxx",
        "extra extra" to "xx",
        "extra" to "x",
        "double" to "xx",
        "triple" to "xxx",
        "small" to "s",
        "medium" to "m",
        "med" to "m",
        "large" to "l",
    )

    private val systemPrefixes = listOf("uk", "eu", "it", "fr", "jp", "au", "us", "de")

    /**
     * A bare number matches only bare numbers; a prefixed one keeps its system.
     * A UK 12 and a US 12 are two different garments, and the corpus warns that
     * treating them as one is the costliest mistake on a UK-sized brand.
     */
    private fun numericAlias(prefix: String, text: String): String {
        val value = text.toDoubleOrNull() ?: 0.0
        val normalized = if (value == floor(value)) value.toInt().toString() else value.toString()
        return if (prefix.isEmpty() || prefix == "us") normalized else prefix + normalized
    }

    /** Lowercase, drop punctuation, spell alpha words as x*[sml], squeeze spaces. */
    private fun normalizeSizeText(part: String): String {
        var text = part.trim().lowercase()
        for (character in listOf("(", ")", ".")) text = text.replace(character, " ")
        text = text.split(" ").filter { it.isNotEmpty() }.joinToString(" ")
        for ((word, replacement) in alphaWords) text = text.replace(word, replacement)
        // Drop spaces, and hyphens that do not join two numbers ("x-large" is
        // one size; "16-18" is a range of two).
        val squeezed = StringBuilder()
        text.forEachIndexed { i, character ->
            when {
                character == ' ' -> Unit
                character == '-' && !(i + 1 < text.length && text[i + 1].isDigit()) -> Unit
                else -> squeezed.append(character)
            }
        }
        return squeezed.toString()
    }

    /** "uk12" → ("uk", "12"); "xl" → ("", "xl"). */
    private fun splitSystemPrefix(text: String): Pair<String, String> {
        for (candidate in systemPrefixes) {
            if (!text.startsWith(candidate)) continue
            val rest = text.removePrefix(candidate)
            if (rest.firstOrNull()?.isDigit() == true) return candidate to rest
        }
        return "" to text
    }

    private fun aliasesForPart(part: String): List<String> {
        val normalized = normalizeSizeText(part)
        if (normalized.isEmpty()) return emptyList()
        val (prefix, text) = splitSystemPrefix(normalized)
        // "16-18" in "UK 16-18 / XL": both numbers name the same row.
        val range = text.split("-")
        val multi = multiAlias(text)
        return when {
            range.size == 2 && range.all { isNumeric(it) } -> range.map { numericAlias(prefix, it) }
            isNumeric(text) -> listOf(numericAlias(prefix, text))
            // "2xl" / "3x" → "xxl" / "xxxl".
            multi != null -> listOf(multi)
            isAlphaSize(text) -> listOf(text)
            // A waist-in-inches tag ("W30") is also written as the bare number
            // by half the sellers on the platform; both name the same row.
            text.startsWith("w") && isNumeric(text.drop(1)) ->
                listOf(text, numericAlias("", text.drop(1)))
            text.isEmpty() -> emptyList()
            else -> listOf(prefix + text)
        }
    }

    private fun isNumeric(text: String): Boolean = text.isNotEmpty() && text.toDoubleOrNull() != null

    /** `x*[sml]`: xs, s, m, l, xl, xxl, xxxl. */
    private fun isAlphaSize(text: String): Boolean {
        val last = text.lastOrNull() ?: return false
        if (last !in "sml") return false
        return text.dropLast(1).all { it == 'x' }
    }

    /** "2x" is the shortest multi-size tag, "3xl" the longest. */
    private const val MULTI_MIN_LENGTH = 2
    private const val MULTI_MAX_LENGTH = 3

    /** Nobody tags a garment 6xl; past this it is not a size, it is a typo. */
    private const val MULTI_MAX_COUNT = 5

    private fun multiAlias(text: String): String? {
        if (text.length < MULTI_MIN_LENGTH || text.length > MULTI_MAX_LENGTH) return null
        val count = text[0].digitToIntOrNull() ?: return null
        if (count < 1 || count > MULTI_MAX_COUNT || text[1] != 'x') return null
        val tail = if (text.length == MULTI_MAX_LENGTH) text[2] else 'l'
        if (tail !in "sl") return null
        return "x".repeat(count) + tail
    }

    private fun aliasesForLabel(label: String): Set<String> =
        label.split('/', ',', '|').flatMap { aliasesForPart(it) }.toSet()

    /**
     * Where an item's size text sits in the band table, or null when nothing
     * matches. Never falls back to row 0 — a size we cannot place is a size we
     * do not judge, and guessing "the first row" would flag the whole chart.
     */
    fun resolveRow(rows: List<BandRow>, size: String?): Int? {
        val label = size?.trim().orEmpty()
        if (label.isEmpty()) return null
        val want = aliasesForLabel(label)
        if (want.isEmpty()) return null
        return rows.firstOrNull { row -> aliasesForLabel(row.size).any { it in want } }?.index
    }

    // ── The check ───────────────────────────────────────────────────────────

    private data class KeyVerdict(
        val key: String,
        val stepsOff: Int,
        val impliedSize: String,
        val expected: List<Double>?,
    )

    private fun measurementFor(measurements: Map<String, Double>, key: String): Double? {
        for (alias in measurementAliases[key].orEmpty()) {
            val value = measurements[alias]
            if (value != null && value > 0.0) return value
        }
        return null
    }

    private fun edgeDistance(band: List<Double>?, value: Double): Double {
        if (band == null || band.size != 2) return Double.MAX_VALUE
        return when {
            value < band[0] -> band[0] - value
            value > band[1] -> value - band[1]
            else -> 0.0
        }
    }

    private fun judge(rows: List<BandRow>, rowIndex: Int, key: String, value: Double): KeyVerdict? {
        val withBand = rows.filter { it.bands[key]?.size == 2 }
        val smallest = withBand.firstOrNull() ?: return null
        val largest = withBand.last()
        val expected = rows.firstOrNull { it.index == rowIndex }?.bands?.get(key)

        val nearestContaining = withBand
            .filter { row ->
                val band = row.bands[key]
                band != null && value >= band[0] && value <= band[1]
            }
            .minByOrNull { abs(it.index - rowIndex) }
        val smallestBand = smallest.bands[key]
        val largestBand = largest.bands[key]

        return when {
            nearestContaining != null ->
                KeyVerdict(key, abs(nearestContaining.index - rowIndex), nearestContaining.size, expected)
            // Off the end of the chart. Naming the edge is the whole point of
            // the motivating case: a 17.5 in flat chest is not "an XS", it is
            // below every size the brand makes, and saying so is more useful
            // than the nearest row's name.
            smallestBand != null && value < smallestBand[0] ->
                KeyVerdict(key, rowIndex - (smallest.index - 1), "smaller than ${smallest.size}", expected)
            largestBand != null && value > largestBand[1] ->
                KeyVerdict(key, largest.index + 1 - rowIndex, "larger than ${largest.size}", expected)
            // In a gap between two bands: take the closer edge.
            else ->
                withBand
                    .minByOrNull { edgeDistance(it.bands[key], value) }
                    ?.let { KeyVerdict(key, abs(it.index - rowIndex), it.size, expected) }
        }
    }

    /**
     * Does the item's own measurement agree with the size on its label?
     *
     * When more than one key can be judged, the one with the LARGEST
     * disagreement wins, so the note names the measurement actually driving it
     * rather than the first one that happened to have a band.
     */
    fun check(rows: List<BandRow>, rowIndex: Int?, measurements: Map<String, Double>, tier: String): Verdict {
        if (rowIndex == null || rows.isEmpty() || tier == "none") return Verdict.UNKNOWN
        if (rows.none { it.index == rowIndex }) return Verdict.UNKNOWN

        // FIRST strict maximum, not maxByOrNull, which returns the LAST of a
        // tie. The other three copies take the first, and a tie between chest
        // and waist would otherwise name a different measurement on Android
        // than on the web for the same garment.
        var worst: KeyVerdict? = null
        for (key in bandKeys) {
            // One `continue`, not two: a key with no measurement and a key with
            // no verdict are the same outcome here, and detekt counts the jumps.
            val verdict = measurementFor(measurements, key)
                ?.let { judge(rows, rowIndex, key, it) }
                ?: continue
            if (verdict.stepsOff > (worst?.stepsOff ?: -1)) worst = verdict
        }
        val found = worst ?: return Verdict.UNKNOWN
        return Verdict(
            status = if (found.stepsOff >= toleranceForTier(tier)) Status.OFF else Status.OK,
            impliedSize = found.impliedSize,
            stepsOff = found.stepsOff,
            key = found.key,
            expected = found.expected,
        )
    }

    // ── Copy ────────────────────────────────────────────────────────────────

    /**
     * The size a "Change to …" action would write, or null when there is
     * nothing to write. An edge verdict names a size the brand does not make, so
     * there is no one-click fix for it — the seller has to decide.
     */
    fun fixableSize(verdict: Verdict): String? {
        val implied = verdict.impliedSize
        if (verdict.status != Status.OFF || implied == null) return null
        if (implied.startsWith("smaller than ") || implied.startsWith("larger than ")) return null
        return implied
    }

    /**
     * The department a chart is resolved by, read off the item's own text.
     *
     * Mirrors `inferDepartment` in `src/lib/ebay-prefill.ts`, narrowed to the
     * two the endpoint accepts. Everything else returns null, and null is a fine
     * answer: the endpoint drops to a generic chart rather than guessing a
     * department, so a wrong guess here is strictly worse than none.
     */
    fun departmentFromText(parts: List<String?>): String? {
        val text = parts.filterNotNull().joinToString(" ").lowercase()
        if (text.isEmpty()) return null
        val kidsMarkers = listOf(
            "baby", "infant", "newborn", "toddler", "boys", "girls",
            "kids", "youth", "junior", "children", "maternity",
        )
        if (kidsMarkers.any { text.contains(it) }) return null
        // Women before men, so "women" is not read as the "men" inside it.
        if (listOf("women", "woman", "ladies", "female", "misses").any { text.contains(it) }) {
            return "Women"
        }
        if (listOf("mens", "men's", "men ", "menswear", "male").any { text.contains(it) }) {
            return "Men"
        }
        return null
    }
}
