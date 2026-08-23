package com.gradethread.app.ai

/**
 * US-1334: where each AI-suggested field actually lives on
 * `inventory_items`, and which values are safe to write.
 *
 * Pure routing logic so the column/attribute split and the enum guards are
 * testable without a database.
 */
object AiItemFields {

    /**
     * Top-level columns the extract can fill.
     *
     * Anything NOT in here and not in [attributeKeys] is dropped rather than
     * written: PostgREST rejects the whole UPDATE on an unknown column, so a
     * single unrecognized suggestion would lose every other field in the same
     * write. The server can add extract fields ahead of this client.
     */
    val columnFields: Set<String> = setOf(
        "title", "brand", "style", "size", "color", "material",
        "item_category", "garment_type", "garment_category",
        "condition_notes", "description",
    )

    /**
     * US-821 canonical attributes — these live in the `attributes` jsonb, NOT
     * as columns. `department` is the one that bites: it looks like an
     * ordinary field, has no column, and writing it top-level fails the
     * entire update.
     */
    val attributeKeys: Set<String> = setOf(
        "department", "size_type", "sleeve_length", "neckline", "pattern",
        "fit", "closure", "features", "garment_care", "country_of_manufacture",
        "vintage", "theme", "mpn", "style_code", "rn_number", "upc",
    )

    /** The only multi-valued canonical attribute. */
    const val MULTI_VALUED_ATTRIBUTE = "features"

    /**
     * `garment_type` and `garment_category` are Postgres ENUMS. An off-vocab
     * value fails the UPDATE with 22P02 and takes every other field with it,
     * so they are validated client-side before the write rather than trusted.
     */
    val garmentTypes: Set<String> = setOf(
        "tops", "bottoms", "outerwear", "dresses", "footwear", "accessories",
    )

    /**
     * US-2815: `neckwear` and `gloves` were MISSING here while the server
     * accepted both. This set filters fields BEFORE the write, so an AI
     * extraction that correctly read a tie came back as neckwear, failed the
     * check, and was dropped - leaving the tie uncategorised. Failing safe, and
     * still the exact outcome US-2224 added those values to prevent: a tie
     * filed as `other` lands in the clothing rubric rather than the accessories
     * one.
     *
     * Held to src/lib/constants.ts by
     * src/test/native-garment-vocabulary-parity.test.ts.
     */
    val garmentCategories: Set<String> = setOf(
        "t-shirt", "shirt", "blouse", "sweater", "hoodie",
        "jacket", "coat", "jeans", "pants", "shorts",
        "skirt", "dress", "sneakers", "boots", "sandals",
        "hat", "bag", "belt", "scarf", "neckwear",
        "gloves", "other",
    )

    /** Enum-typed columns and their permitted vocabularies. */
    private val enumVocabularies: Map<String, Set<String>> = mapOf(
        "garment_type" to garmentTypes,
        "garment_category" to garmentCategories,
    )

    /**
     * Whether [value] can be written to [field] without failing the UPDATE.
     * A blank value is allowed for non-enum columns — that is how an undone
     * field with no previous value gets cleared.
     */
    fun isWritable(field: String, value: String): Boolean {
        val vocabulary = enumVocabularies[field] ?: return true
        // An enum column cannot take "" — clearing means NULL, which the
        // writer expresses separately.
        return value in vocabulary
    }

    data class Routed(
        /** Top-level column updates. */
        val columns: Map<String, String> = emptyMap(),
        /** Canonical attribute updates, merged into the `attributes` jsonb. */
        val attributes: Map<String, String> = emptyMap(),
        /** Columns to NULL out — an undone field with nothing to revert to. */
        val cleared: Set<String> = emptySet(),
        /** Suggestions we refused to write, with the reason. */
        val rejected: Map<String, String> = emptyMap(),
    )

    /**
     * Split resolved review values into what the write actually needs.
     *
     * @param values field -> final value, from [AiExtractReview.resolvedValues].
     */
    fun route(values: Map<String, String>): Routed {
        val columns = mutableMapOf<String, String>()
        val attributes = mutableMapOf<String, String>()
        val cleared = mutableSetOf<String>()
        val rejected = mutableMapOf<String, String>()

        for ((field, value) in values) {
            when {
                field in attributeKeys -> {
                    if (value.isBlank()) cleared += field else attributes[field] = value
                }

                field !in columnFields ->
                    // Unknown to this client — drop it rather than risk the
                    // whole UPDATE on a column that may not exist.
                    rejected[field] = "unknown field"

                value.isBlank() ->
                    // Undone with no previous value: NULL it, don't write "".
                    cleared += field

                !isWritable(field, value) ->
                    rejected[field] = "not a valid $field value"

                else -> columns[field] = value
            }
        }
        return Routed(columns, attributes, cleared, rejected)
    }

    /**
     * Merge new attribute values over the existing jsonb.
     *
     * Read-modify-write, because a jsonb column UPDATE REPLACES the whole
     * document — writing only the new keys would silently delete every
     * attribute the server already gap-filled.
     */
    fun mergeAttributes(
        existing: Map<String, String>,
        updates: Map<String, String>,
        cleared: Set<String> = emptySet(),
    ): Map<String, String> {
        val merged = existing.toMutableMap()
        merged.putAll(updates)
        cleared.forEach { merged.remove(it) }
        return merged
    }

    /**
     * Merge provenance over the existing `ai_field_sources`, dropping entries
     * for fields that are no longer AI-attributed.
     *
     * Same replace-not-merge hazard as [mergeAttributes].
     */
    fun mergeFieldSources(
        existing: Map<String, String>,
        sources: Map<String, String>,
        noLongerAiAttributed: Set<String> = emptySet(),
    ): Map<String, String> {
        val merged = existing.toMutableMap()
        merged.putAll(sources)
        noLongerAiAttributed.forEach { merged.remove(it) }
        return merged
    }
}
