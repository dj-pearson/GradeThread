package com.gradethread.app.templates

/**
 * US-1373 AC2: what applying a template actually does to a composer.
 *
 * Pure, because the rules here are the whole story and they are easy to get
 * subtly wrong in a way nobody notices until a listing goes out with the wrong
 * condition on it.
 *
 * Two different rules, on purpose:
 *
 *  - CONDITION and its description come from the template and win. The seller
 *    just tapped "apply"; refusing to change the thing the template exists to
 *    set would make the button look broken.
 *  - ITEM SPECIFICS fill blanks only. Those may already hold values derived
 *    from the item's own measurements or from the AI extract, and a template's
 *    generic default is worse information than a value measured off the actual
 *    garment.
 */
object TemplateApply {

    /** The slice of the publish composer a template can touch. */
    data class Target(
        val condition: String,
        val conditionDescription: String,
        val specifics: Map<String, List<String>>,
    )

    data class Result(
        val target: Target,
        /** Field names that actually changed, for the confirmation line. */
        val changed: List<String>,
        /** Specifics the template offered but the seller had already filled. */
        val keptExisting: List<String>,
    ) {
        /** What to tell the seller, naming what was left alone. */
        val message: String
            get() = when {
                changed.isEmpty() && keptExisting.isEmpty() ->
                    "That template didn't have anything to add."
                changed.isEmpty() ->
                    "Nothing changed. You'd already filled in everything it sets."
                keptExisting.isEmpty() -> "Applied: ${changed.joinToString(", ")}."
                else -> "Applied: ${changed.joinToString(", ")}. Kept what you'd already " +
                    "set for ${keptExisting.joinToString(", ")}."
            }
    }

    fun apply(template: ListingTemplate, target: Target): Result {
        val changed = mutableListOf<String>()
        val kept = mutableListOf<String>()

        val condition = template.ebayCondition?.takeIf { it.isNotBlank() }
        val nextCondition = condition ?: target.condition
        if (condition != null && condition != target.condition) {
            changed += "condition"
        }

        // Only when the template HAS one. A template with no condition
        // description must not wipe a description the seller wrote.
        val description = template.conditionDescription?.takeIf { it.isNotBlank() }
        val nextDescription = description ?: target.conditionDescription
        if (description != null && description != target.conditionDescription) {
            changed += "condition notes"
        }

        val specifics = target.specifics.toMutableMap()
        var filled = 0
        for ((aspect, value) in template.itemSpecifics) {
            val name = aspect.trim()
            if (name.isEmpty() || value.isBlank()) continue
            val existing = specifics[name].orEmpty().filter { it.isNotBlank() }
            if (existing.isNotEmpty()) {
                // Named rather than silently skipped: a template that appears to
                // do nothing is indistinguishable from one that failed.
                if (existing != listOf(value.trim())) kept += name
                continue
            }
            specifics[name] = listOf(value.trim())
            filled++
        }
        if (filled > 0) {
            changed += "$filled ${if (filled == 1) "specific" else "specifics"}"
        }

        return Result(
            target = Target(nextCondition, nextDescription, specifics),
            changed = changed,
            keptExisting = kept,
        )
    }

    /**
     * The template to pre-select.
     *
     * The seller's default if they marked one, otherwise nothing — picking the
     * first template alphabetically would silently apply someone else's
     * boilerplate to a listing.
     */
    fun preselected(templates: List<ListingTemplate>): ListingTemplate? =
        templates.firstOrNull { it.isDefault }

    /** Display order: sort_order, then name, so the picker is stable. */
    fun ordered(templates: List<ListingTemplate>): List<ListingTemplate> =
        templates.sortedWith(
            compareBy<ListingTemplate> { it.sortOrder }.thenBy { it.name.lowercase() },
        )
}
