package com.gradethread.app.vision

/**
 * US-1333: brand and size inferred from OCR'd care-tag text, entirely
 * on-device. Port of the iOS `SizeTagInference` (US-177).
 *
 * The governing rule is **return nothing rather than guess**. An empty field
 * costs the seller one correction; a confidently wrong brand or size gets
 * listed, sold, and disputed. Every heuristic here is deliberately narrow,
 * and there is no "best effort" fallback.
 *
 * Pure text in, pure text out — no Android or ML Kit types — so the whole
 * rule set is unit-testable without a photo or a device.
 */
object SizeTagInference {

    /**
     * Confidence stamped on any suggestion this produces.
     *
     * Deliberately BELOW the auto-apply bar (iOS `autoApplyConfidenceThreshold`
     * = 0.5): OCR guesses are offered for explicit opt-in, never silently
     * written into the form. Keep these two in lockstep — raising this above
     * the bar would start auto-applying tag guesses.
     */
    const val SUGGESTION_CONFIDENCE: Double = 0.4

    /** Source label shown on the review row. */
    const val SOURCE_LABEL: String = "On-device OCR"

    /**
     * The alpha size vocabulary. Matched by EXACT set membership, never as a
     * substring — "MADE IN MALAYSIA" must not yield "M".
     *
     * Known gaps, carried over from iOS rather than silently widened: no
     * 2XL/3XL/4XL numeric-prefixed forms, no PETITE/TALL, no ONE SIZE. Adding
     * them is a product decision, and it must be made on both platforms at
     * once or the same tag infers differently per phone.
     */
    val alphaSizes: Set<String> = setOf(
        "XXXL", "XXL", "XL", "L", "M", "S", "XS", "XXS",
    )

    /**
     * Brand whitelist. There is NO fuzzy matching and no "prominent uppercase
     * line" heuristic — that was tried on iOS and surfaced collection names
     * (SYNCHILLA, HERITAGE) as brands.
     */
    val knownBrands: Set<String> = setOf(
        "patagonia", "the north face", "north face",
        "nike", "adidas", "puma", "new balance", "reebok",
        "levi's", "levis", "lee", "wrangler", "dickies",
        "carhartt", "filson", "pendleton",
        "polo ralph lauren", "ralph lauren", "lacoste", "tommy hilfiger",
        "j crew", "j.crew", "jcrew", "banana republic", "gap",
        "uniqlo", "muji",
        "lululemon", "athleta",
        "supreme", "stussy", "stüssy", "bape",
        "champion", "fila",
        "calvin klein", "diesel", "guess",
        "burberry", "gucci", "prada", "louis vuitton",
        "vineyard vines", "brooks brothers",
    )

    // Compiled once: detectBrand runs the whole whitelist against every OCR
    // result, and recompiling ~40 patterns per scan is pure waste.
    private val brandPatterns: List<Pair<String, Regex>> by lazy {
        knownBrands.map { brand -> brand to wordBoundaryPattern(brand) }
    }

    /**
     * Word-boundary match, NOT substring `contains`. This is the entire
     * defense against "fleece" matching `lee`, "Supremely" matching
     * `supreme`, and "gaps" matching `gap` — all three are real regressions
     * with tests on iOS.
     *
     * Literal spaces become `\s+` so multi-word brands survive OCR line
     * joins and double spaces.
     */
    private fun wordBoundaryPattern(brand: String): Regex {
        val escaped = brand.split(" ").joinToString("""\s+""") { Regex.escape(it) }
        return Regex("""\b$escaped\b""", RegexOption.IGNORE_CASE)
    }

    /**
     * @return the title-cased brand, or null when nothing in the whitelist
     * matches. Never a guess.
     */
    fun detectBrand(lines: List<String>): String? {
        // Matched against the whole tag joined, not per line: OCR routinely
        // splits "THE NORTH FACE" across two lines.
        val haystack = lines.joinToString(" ").lowercase()
        // Longest match wins. `knownBrands` deliberately contains overlapping
        // entries ("north face" ⊂ "the north face", "levis" ⊂ "levi's"), and
        // without this the result would depend on set iteration order.
        val best = brandPatterns
            .filter { (_, pattern) -> pattern.containsMatchIn(haystack) }
            .maxByOrNull { (brand, _) -> brand.length }
            ?.first
            ?: return null
        return titleCased(best)
    }

    /** Per-token first-character uppercase, matching iOS exactly. */
    private fun titleCased(value: String): String =
        value.split(" ").joinToString(" ") { token ->
            if (token.isEmpty()) token else token.take(1).uppercase() + token.drop(1)
        }

    /**
     * Four full passes over ALL lines, in precedence order. Each pass scans
     * every line before the next begins, so a waist×length anywhere on the
     * tag beats an alpha size on line 1 — jeans tags carry both, and the
     * measurement is the more specific answer.
     */
    fun detectSize(lines: List<String>): String? {
        lines.forEach { line -> matchWaistLength(line)?.let { return it } }
        lines.forEach { line -> matchExplicitSize(line)?.let { return it } }
        lines.forEach { line -> matchAlphaSize(line)?.let { return it } }
        lines.forEach { line -> matchNumericSize(line)?.let { return it } }
        return null
    }

    // Pass 1. Handles "30x32", "30 x 32", "W30 L32", "W30L32", "30×32".
    private val waistLength = Regex(
        """\bW?(\d{2})\s*(?:[xX×]\s*L?|L)(\d{2})\b""",
        RegexOption.IGNORE_CASE,
    )

    fun matchWaistLength(line: String): String? {
        val match = waistLength.find(line) ?: return null
        val waist = match.groupValues[1]
        val length = match.groupValues[2]
        // Plausibility bounds keep style numbers and years out: "10x20" is
        // not a waist, and a garment tag full of digits is otherwise a
        // generous source of false positives.
        val w = waist.toIntOrNull() ?: return null
        if (w !in 22..60) return null
        val l = length.toIntOrNull() ?: return null
        if (l !in 24..40) return null
        // Normalized to lowercase x, no spaces, so the stored SKU-adjacent
        // value is stable regardless of how the tag printed it.
        return "${waist}x$length"
    }

    // Pass 2. "Size: M", "SIZE 12", "size#8".
    private val explicitSize = Regex(
        """\bsize\s*[:#]?\s*(\S{1,5})\b""",
        RegexOption.IGNORE_CASE,
    )

    fun matchExplicitSize(line: String): String? {
        val match = explicitSize.find(line) ?: return null
        val raw = match.groupValues[1].uppercase()
        if (raw in alphaSizes) return raw
        val n = raw.toIntOrNull() ?: return null
        // 1..60 — wider than the bare-numeric pass, because an explicit
        // "Size" prefix is strong evidence. Still excludes 0: a bare "0"
        // here is far more often a care-symbol code or OCR noise.
        return if (n in 1..60) raw else null
    }

    // Pass 3. The WHOLE line must be an alpha size.
    fun matchAlphaSize(line: String): String? {
        val trimmed = line.trim().uppercase()
        return if (trimmed in alphaSizes) trimmed else null
    }

    // Pass 4. The WHOLE line must be a plausible bare number.
    fun matchNumericSize(line: String): String? {
        val trimmed = line.trim()
        val n = trimmed.toIntOrNull() ?: return null
        // Capped at 54 so a year ("2024") or a style code can't become a
        // size. Narrower than pass 2 precisely because there is no "Size"
        // prefix vouching for it.
        return if (n in 1..54) n.toString() else null
    }

    /**
     * What the OCR fallback contributes. A null field means "no opinion" —
     * never a signal to clear an existing value.
     */
    data class Inference(val brand: String? = null, val size: String? = null) {
        val isEmpty: Boolean get() = brand == null && size == null
    }

    /**
     * The fill-blanks gate: infer ONLY the fields that are still missing.
     *
     * This is what makes the fallback safe to run after a successful AI
     * extract — a value Claude or the seller already provided is never
     * recomputed, so it can never be overwritten by a weaker OCR guess.
     * Callers that already have both fields get an empty result and should
     * skip the OCR pass entirely.
     */
    fun infer(
        lines: List<String>,
        existingBrand: String? = null,
        existingSize: String? = null,
    ): Inference = Inference(
        brand = if (existingBrand.isNullOrBlank()) detectBrand(lines) else null,
        size = if (existingSize.isNullOrBlank()) detectSize(lines) else null,
    )

    /**
     * Whether an OCR pass is worth running at all. Cheap pre-check so the
     * caller can skip decoding and downsampling the tag photo.
     */
    fun needsInference(existingBrand: String?, existingSize: String?): Boolean =
        existingBrand.isNullOrBlank() || existingSize.isNullOrBlank()
}
