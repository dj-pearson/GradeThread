package com.gradethread.app.inventory

import kotlinx.serialization.Serializable

/**
 * US-1347: the category's aspect spec, as eBay describes it.
 *
 * Note the DOUBLE NESTING in [AspectSpecResponse]: the edge returns
 * `{ aspects: { aspects: [...] } }` because it passes eBay's own envelope
 * through untouched. Flattening it here would be a lie about the wire, so it
 * is modelled as it arrives and unwrapped once, in one place.
 */
@Serializable
data class AspectValueOption(val localizedValue: String = "")

@Serializable
data class AspectConstraint(
    val aspectDataType: String? = null,
    /** "FREE_TEXT" | "SELECTION_ONLY" — a closed list only when SELECTION_ONLY. */
    val aspectMode: String? = null,
    val aspectRequired: Boolean = false,
    /** "RECOMMENDED" | "OPTIONAL". */
    val aspectUsage: String? = null,
    /** "SINGLE" | "MULTI". */
    val itemToAspectCardinality: String? = null,
)

@Serializable
data class EbayAspect(
    val localizedAspectName: String = "",
    val aspectConstraint: AspectConstraint = AspectConstraint(),
    val aspectValues: List<AspectValueOption> = emptyList(),
) {
    val name: String get() = localizedAspectName.trim()
    val required: Boolean get() = aspectConstraint.aspectRequired
    val recommended: Boolean get() = aspectConstraint.aspectUsage == "RECOMMENDED"

    /** MULTI means the seller may pick several values for this one aspect. */
    val multiValued: Boolean get() = aspectConstraint.itemToAspectCardinality == "MULTI"

    /**
     * A closed list — anything not in [allowedValues] is rejected by eBay.
     *
     * Only SELECTION_ONLY is closed. FREE_TEXT and SUGGESTED still carry
     * `aspectValues`, but those are hints, and treating them as a closed list
     * would block a seller from entering a legitimate value eBay would accept.
     */
    val selectionOnly: Boolean get() = aspectConstraint.aspectMode == "SELECTION_ONLY"

    val allowedValues: List<String>
        get() = aspectValues.map { it.localizedValue.trim() }.filter { it.isNotEmpty() }
}

/** eBay's own envelope, passed through by the edge. */
@Serializable
data class AspectEnvelope(val aspects: List<EbayAspect> = emptyList())

@Serializable
data class AspectSpecResponse(
    val aspects: AspectEnvelope = AspectEnvelope(),
    val categoryName: String? = null,
    val cached: Boolean = false,
) {
    /** The flat list, unwrapped from eBay's own envelope exactly once. */
    val aspectList: List<EbayAspect>
        get() = aspects.aspects.filter { it.name.isNotEmpty() }
}

/**
 * US-2494: the answer from `POST /category/:id/derive-aspects`.
 *
 * Free — no AI action, no rows written. The server fills aspect gaps from the
 * item's own columns, US-821 attributes and US-1503 measurements, then names
 * the five column-owned aspects separately because those are not gap-fills:
 * Brand/Size/Color/Material/Style belong to the item's columns and have to
 * overwrite whatever provenance the aspect currently carries.
 *
 * Every field defaults, so an older edge build that returns neither
 * [columnOwned] nor [columnCleared] decodes to the previous behaviour instead
 * of failing the whole call.
 */
@Serializable
data class DerivedAspects(
    val categoryId: String = "",
    val derived: Map<String, List<String>> = emptyMap(),
    /** Wire provenance per derived aspect; every gap-fill is `inventory_derived`. */
    val sources: Map<String, String> = emptyMap(),
    /** Every aspect name this category exposes. */
    val validAspectNames: List<String> = emptyList(),
    /** Overwrite these even when they are currently marked manual or AI. */
    val columnOwned: List<String> = emptyList(),
    /** The backing column was blanked — drop these rather than keep a stale value. */
    val columnCleared: List<String> = emptyList(),
)

/** What the aspects editor is showing. */
sealed class AspectSpecState {
    object Idle : AspectSpecState()
    object Loading : AspectSpecState()
    data class Loaded(val aspects: List<EbayAspect>, val categoryName: String?) : AspectSpecState()

    /** No eBay category on the item yet — the spec can't be fetched at all. */
    object NoCategory : AspectSpecState()

    data class Failed(val message: String) : AspectSpecState()
}

object AspectSpecs {

    /**
     * Editor order: required first, then recommended, then the rest —
     * alphabetically within each band.
     *
     * Required aspects lead because they are the ones that block a publish. A
     * plain alphabetical list buries them among forty optional ones, which is
     * how an item reaches the publish step still missing Department.
     */
    fun ordered(aspects: List<EbayAspect>): List<EbayAspect> = aspects.sortedWith(
        compareBy(
            { if (it.required) 0 else if (it.recommended) 1 else 2 },
            { it.name.lowercase() },
        ),
    )

    /** The names of the required aspects, for the publish-blocker check. */
    fun requiredNames(aspects: List<EbayAspect>): List<String> =
        aspects.filter { it.required }.map { it.name }.filter { it.isNotEmpty() }

    /**
     * Normalise a typed value against a closed list.
     *
     * Returns null when the aspect is SELECTION_ONLY and the value matches
     * nothing — better to refuse it in the editor than to have eBay reject the
     * whole publish for one unrecognised specific. Free-text aspects pass
     * through untouched.
     */
    fun normalize(aspect: EbayAspect, value: String): String? {
        val raw = value.trim()
        if (raw.isEmpty()) return null
        if (!aspect.selectionOnly) return raw
        val allowed = aspect.allowedValues
        if (allowed.isEmpty()) return null
        return allowed.firstOrNull { it.equals(raw, ignoreCase = true) }
    }
}
