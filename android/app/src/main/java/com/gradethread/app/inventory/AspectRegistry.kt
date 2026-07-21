package com.gradethread.app.inventory

/**
 * US-1347: which item fields own which eBay aspects.
 *
 * A Kotlin mirror of `src/lib/ebay-aspect-registry.json` (version 1, 18
 * entries). Ported as code rather than shipped as an asset so a drift shows up
 * as a failing test rather than a silently unread file — the registry is small
 * and changes rarely.
 *
 * `aspects` lists the names eBay uses for the same concept across categories
 * ("Color" / "Colour"), first entry canonical.
 */
object AspectRegistry {

    enum class Source { COLUMN, ATTRIBUTE }

    data class Entry(
        val key: String,
        val source: Source,
        /** The `inventory_items` column or the US-821 attribute key. */
        val field: String,
        val multi: Boolean,
        val aspects: List<String>,
    ) {
        /** The name written when this entry projects a value. */
        val canonicalAspect: String get() = aspects.first()
    }

    val entries: List<Entry> = listOf(
        Entry("brand", Source.COLUMN, "brand", false, listOf("Brand")),
        Entry("size", Source.COLUMN, "size", false, listOf("Size")),
        Entry("color", Source.COLUMN, "color", false, listOf("Color", "Colour")),
        Entry(
            "material", Source.COLUMN, "material", false,
            listOf("Material", "Fabric Type", "Outer Shell Material"),
        ),
        Entry("style", Source.COLUMN, "style", false, listOf("Style", "Type")),
        Entry("department", Source.ATTRIBUTE, "department", false, listOf("Department")),
        Entry("size_type", Source.ATTRIBUTE, "size_type", false, listOf("Size Type")),
        Entry(
            "sleeve_length", Source.ATTRIBUTE, "sleeve_length", false,
            listOf("Sleeve Length"),
        ),
        Entry("neckline", Source.ATTRIBUTE, "neckline", false, listOf("Neckline")),
        Entry("pattern", Source.ATTRIBUTE, "pattern", false, listOf("Pattern")),
        Entry("fit", Source.ATTRIBUTE, "fit", false, listOf("Fit")),
        Entry("closure", Source.ATTRIBUTE, "closure", false, listOf("Closure")),
        Entry("features", Source.ATTRIBUTE, "features", true, listOf("Features")),
        Entry("garment_care", Source.ATTRIBUTE, "garment_care", false, listOf("Garment Care")),
        Entry(
            "country_of_manufacture", Source.ATTRIBUTE, "country_of_manufacture", false,
            listOf("Country/Region of Manufacture"),
        ),
        Entry("vintage", Source.ATTRIBUTE, "vintage", false, listOf("Vintage")),
        Entry("theme", Source.ATTRIBUTE, "theme", false, listOf("Theme")),
        Entry("mpn", Source.ATTRIBUTE, "mpn", false, listOf("MPN")),
    )

    /** Entries fed by a structured column — the ones a canvas edit projects. */
    val columnEntries: List<Entry> = entries.filter { it.source == Source.COLUMN }

    /**
     * The item FIELD an aspect name is two-way synced with, or null for an
     * AI- or free-typed aspect. Drives the editor's "synced with item field"
     * hint, so a seller understands why editing one moves the other.
     */
    fun syncedFieldFor(aspectName: String): String? {
        val name = aspectName.trim().lowercase()
        if (name.isEmpty()) return null
        return entries.firstOrNull { entry ->
            entry.aspects.any { it.lowercase() == name }
        }?.field
    }
}
