package com.gradethread.app.marketplaces.publish

import com.gradethread.app.inventory.AspectSpecs
import com.gradethread.app.inventory.EbayAspect
import com.gradethread.app.inventory.MeasurementCatalog

/**
 * US-1353: the listing-time item-specifics rules.
 *
 * The editor writes `listings.item_specifics_override` — the per-LISTING map,
 * which the edge reads FIRST when it assembles a publish. That is what makes
 * this different from the item canvas's aspects editor (US-1347), which writes
 * the item-level `inventory_items.ebay_aspects`: a value set here applies to
 * this listing only, and it wins.
 *
 * All pure, so the two rules that decide whether the seller can publish — what
 * counts as missing, and what the server will fill in for them — are tested
 * rather than only seen on screen.
 */
object ListingSpecifics {

    /** One row of the editor. */
    data class Field(
        val aspect: EbayAspect,
        val values: List<String>,
        /**
         * The server will fill this at publish from the item's measurements
         * (`resolveMeasurementAspects`). Shown as already-handled rather than as
         * a gap, so the seller doesn't type a number the publish overwrites.
         */
        val autoFilledFrom: String? = null,
    ) {
        val name: String get() = aspect.name
        val filled: Boolean get() = values.any { it.isNotBlank() } || autoFilledFrom != null

        /** A required aspect with nothing in it is what blocks the publish. */
        val blocking: Boolean get() = aspect.required && !filled
    }

    /**
     * Which category aspects the publish will fill from the item's
     * measurements, and with what.
     *
     * A FAITHFUL port of the edge's `resolveMeasurementAspects`, including the
     * three rules that are easy to get subtly wrong:
     *  - only aspects with NO allowed values are eligible (an aspect with a
     *    closed list would reject a free-form "20 in");
     *  - an aspect already carrying a value is left alone — the seller's value
     *    wins over the derived one;
     *  - the FIRST matching candidate name wins, and one measurement fills at
     *    most one aspect.
     *
     * Getting this wrong in the client's favour would be the worse failure:
     * telling a seller a required aspect is handled when the server won't
     * actually fill it means a publish that fails after they hit the button.
     */
    fun measurementAspects(
        aspects: List<EbayAspect>,
        measurements: Map<String, Double>,
        existing: Map<String, List<String>>,
    ): Map<String, String> {
        val freeTextByLower = aspects
            .filter { it.allowedValues.isEmpty() }
            .associateBy { it.name.lowercase() }
        val existingLower = existing
            .filterValues { values -> values.any { it.isNotBlank() } }
            .keys
            .map { it.lowercase() }
            .toSet()

        val out = LinkedHashMap<String, String>()
        for ((key, candidates) in MeasurementCatalog.aspectCandidates) {
            val value = measurements[key] ?: continue
            val formatted = MeasurementCatalog.publishValue(key, value) ?: continue
            for (candidate in candidates) {
                val lower = candidate.lowercase()
                val canonical = freeTextByLower[lower]?.name ?: continue
                if (lower in existingLower || canonical in out) continue
                out[canonical] = formatted
                break // first matching candidate wins
            }
        }
        return out
    }

    /** The editor's rows: required first, each carrying its current value. */
    fun fields(
        aspects: List<EbayAspect>,
        values: Map<String, List<String>>,
        measurements: Map<String, Double> = emptyMap(),
    ): List<Field> {
        val derived = measurementAspects(aspects, measurements, values)
        return AspectSpecs.ordered(aspects).map { aspect ->
            Field(
                aspect = aspect,
                values = values[aspect.name].orEmpty(),
                autoFilledFrom = derived[aspect.name],
            )
        }
    }

    /**
     * Required aspects with nothing in them — the same rule the edge applies at
     * publish, run locally so the button is off BEFORE the round trip.
     *
     * A local mirror, never the authority: the server re-checks and its answer
     * wins. The point is that a seller who is missing Department finds out while
     * looking at the field, not after a failed publish.
     */
    fun missingRequired(
        aspects: List<EbayAspect>,
        values: Map<String, List<String>>,
        measurements: Map<String, Double> = emptyMap(),
    ): List<String> = fields(aspects, values, measurements)
        .filter { it.blocking }
        .map { it.name }

    /** The blocker lines the composer shows for [missingRequired]. */
    fun blockers(missing: List<String>): List<String> =
        missing.map { "$it is required for this eBay category." }

    /**
     * Set one aspect's values, normalised against the category spec.
     *
     * A value that a SELECTION_ONLY aspect doesn't allow is DROPPED here rather
     * than sent: eBay rejects the whole publish over one unrecognised specific,
     * so refusing it in the editor is the kinder failure.
     */
    fun set(
        values: Map<String, List<String>>,
        aspect: EbayAspect,
        newValues: List<String>,
    ): Map<String, List<String>> {
        val cleaned = newValues
            .mapNotNull { AspectSpecs.normalize(aspect, it) }
            .distinct()
            // A single-valued aspect takes one value; eBay ignores the rest, and
            // keeping them would show the seller a list that isn't published.
            .let { if (aspect.multiValued) it else it.take(1) }

        val next = values.toMutableMap()
        if (cleaned.isEmpty()) next.remove(aspect.name) else next[aspect.name] = cleaned
        return next
    }
}
