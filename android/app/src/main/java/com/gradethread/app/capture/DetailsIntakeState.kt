package com.gradethread.app.capture

import kotlinx.serialization.Serializable

/**
 * US-1330: the details-first intake form model (iOS `IntakeFormState`).
 *
 * Immutable + `@Serializable` so the whole form IS the autosaved draft — the
 * same shape `PhotoIntakeStore` uses for capture sessions. Enum-ish fields are
 * stored as RAW STRINGS so a future category/status value can't make an older
 * draft undecodable (it falls back to the default instead).
 */
@Serializable
data class DetailsIntakeState(
    // Identity
    val title: String = "",
    val sku: String = "",
    val brand: String = "",
    val style: String = "",
    val size: String = "",
    val color: String = "",
    val material: String = "",
    val category: String = FlipdeskCategory.CLOTHING.wire,
    val status: String = IntakeStatus.CATALOGED.wire,
    // Sourcing — deliberately preserved across "Save & add another"
    val sourceId: String? = null,
    val container: String = "",
    val sourcedBy: String = "",
    /** `YYYY-MM-DD`. Postgres `acquired_date` is a DATE — never send a time. */
    val purchaseDate: String = "",
    val purchasePriceText: String = "",
    // Notes → maps to the item's `description` column, NOT condition_notes.
    val notes: String = "",
) {

    /** Title is the ONLY required field — matches the web intake form. */
    val canSubmit: Boolean get() = title.isNotBlank()

    /**
     * One source of truth for the inline [com.gradethread.app.ui.components.FieldError]
     * and the accessibility announcement, so they can never disagree.
     */
    val titleValidationMessage: String?
        get() = if (title.isBlank()) "A title is required to save" else null

    /**
     * Worth persisting? An all-blank form is DELETED rather than saved, so a
     * user who opens intake and backs out isn't prompted to resume nothing.
     */
    val hasContent: Boolean
        get() = listOf(
            title, sku, brand, style, size, color, material,
            container, sourcedBy, notes, purchasePriceText,
        ).any { it.isNotBlank() }

    /**
     * Every field joined by a unit separator. Autosave keys off this, so a
     * change to ANY field triggers exactly one save and an unrelated
     * recomposition triggers none.
     */
    val draftSignature: String
        get() = listOf(
            title, sku, brand, style, size, color, material, category, status,
            sourceId.orEmpty(), container, sourcedBy, purchaseDate,
            purchasePriceText, notes,
        ).joinToString(UNIT_SEPARATOR)

    /** Soft-clamp the title rather than silently dropping the overflow. */
    fun clampTitle(): DetailsIntakeState =
        if (title.length <= TITLE_LIMIT) this else copy(title = title.take(TITLE_LIMIT))

    /**
     * Batch cataloging: clear identity/notes/price but KEEP the sourcing
     * context — the next item almost always came from the same haul.
     */
    fun resetForAddAnother(): DetailsIntakeState = DetailsIntakeState(
        category = category,
        status = status,
        sourceId = sourceId,
        container = container,
        sourcedBy = sourcedBy,
        purchaseDate = purchaseDate,
    )

    companion object {
        const val TITLE_LIMIT = 140

        /**
         * U+001F. A control char no user can type, so two fields' contents can
         * never collide into an identical signature (a plain "," could).
         */
        const val UNIT_SEPARATOR = "\u001F"
    }
}

/** `item_category` values — the full iOS `FlipdeskCategory` set, in its order. */
enum class FlipdeskCategory(val wire: String, val label: String) {
    CLOTHING("clothing", "Clothing"),
    SHOES("shoes", "Shoes"),
    WATCHES("watches", "Watches"),
    SPORTS_CARDS("sports_cards", "Sports cards"),
    COLLECTIBLES("collectibles", "Collectibles"),
    ELECTRONICS("electronics", "Electronics"),
    BOOKS("books", "Books"),
    JEWELRY("jewelry", "Jewelry"),
    BAGS("bags", "Bags"),
    // Non-garment accessories sold standalone (hats, belts, sunglasses).
    ACCESSORIES("accessories", "Accessories"),
    OTHER("other", "Other");

    companion object {
        /** Unknown/legacy wire values fall back rather than throwing. */
        fun from(wire: String?): FlipdeskCategory =
            entries.firstOrNull { it.wire == wire } ?: CLOTHING
    }
}

/** The `item_status` values reachable from manual intake (iOS IntakeStatus). */
enum class IntakeStatus(val wire: String, val label: String) {
    SOURCED("sourced", "Sourced (not yet cataloged)"),
    CATALOGED("cataloged", "Cataloged"),
    KEEPING("keeping", "Keeping (personal)"),
    WEARING("wearing", "Wearing (personal)");

    companion object {
        fun from(wire: String?): IntakeStatus =
            entries.firstOrNull { it.wire == wire } ?: CATALOGED
    }
}
