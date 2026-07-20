package com.gradethread.app.ai

/**
 * US-1334: turning a raw extract response into the tiered review the seller
 * confirms. Port of the iOS `AIExtractStore.applyResponse` + `AIFillReview`.
 *
 * Pure data in, pure data out — no network, no Android types — so every
 * threshold and conflict rule below is unit-testable.
 */
object AiExtractReview {

    /**
     * At or above this, a suggestion is auto-applied and shown pre-checked;
     * below it, the seller must opt in explicitly.
     *
     * Lockstep: the OCR fallback stamps 0.4 (see
     * `SizeTagInference.SUGGESTION_CONFIDENCE`) precisely so it lands BELOW
     * this bar. Raising this above 0.4 would start silently auto-applying
     * on-device OCR guesses.
     */
    const val AUTO_APPLY_CONFIDENCE: Double = 0.5

    /**
     * US-1217: for these fields the printed tag beats what the photo model
     * inferred. A care tag saying "M" is more authoritative than a drape
     * estimate, and these three are the ones sellers get burned on.
     */
    val conflictReviewFields: Set<String> = setOf("size", "brand", "department")

    /** Ceiling applied to any conflicted field — always below the auto-apply bar. */
    const val CONFLICT_CONFIDENCE: Double = 0.4

    data class AppliedField(
        val field: String,
        val value: String,
        /** The undo target — what the field held before the AI wrote it. */
        val previousValue: String?,
        val confidence: Double,
        val source: String,
    )

    data class Review(
        val itemId: String,
        val applied: List<AppliedField> = emptyList(),
        val lowConfidence: List<FieldSuggestionEntry> = emptyList(),
        val measurements: Map<String, Double> = emptyMap(),
        val measurementsApplied: Boolean = false,
        val conditionSummary: String? = null,
        val usedLiveTextFallback: Boolean = false,
        val ebayPending: Boolean = false,
        val researchRationale: String? = null,
        val logId: String? = null,
        val actionsRemaining: Int = AiExtractResponse.ACTIONS_REMAINING_UNKNOWN,
    ) {
        val appliedCount: Int
            get() = applied.size + if (measurementsApplied) measurements.size else 0

        val hasSomethingToReview: Boolean
            get() = applied.isNotEmpty() || lowConfidence.isNotEmpty() ||
                measurementsApplied || ebayPending

        /** The inventory-row entry point copy, mirroring iOS. */
        val entryPointLabel: String
            get() = when {
                appliedCount > 0 -> "AI filled $appliedCount fields — review"
                lowConfidence.isNotEmpty() -> "AI has ${lowConfidence.size} suggestions — review"
                else -> "Review AI suggestions"
            }

        /** Quota is only worth showing when the server actually reported it. */
        val quotaLabel: String?
            get() = when (actionsRemaining) {
                AiExtractResponse.ACTIONS_REMAINING_UNKNOWN -> null
                AiExtractResponse.ACTIONS_REMAINING_UNLIMITED -> null
                0 -> "No AI actions left this period"
                1 -> "1 AI action left this period"
                else -> "$actionsRemaining AI actions left this period"
            }
    }

    /**
     * Fold the response into review tiers.
     *
     * @param existingValues current item values, used purely as undo targets.
     */
    fun build(
        itemId: String,
        response: AiExtractResponse,
        existingValues: Map<String, String> = emptyMap(),
        usedLiveTextFallback: Boolean = false,
    ): Review {
        val entries = resolveConflicts(response.suggestions, response.conflicts)
            // Alphabetical and stable: the sheet must not reshuffle between
            // renders, and confidence order would move rows as values change.
            .sortedBy { it.field }

        val (applied, low) = entries.partition { it.suggestion.confidence >= AUTO_APPLY_CONFIDENCE }

        return Review(
            itemId = itemId,
            applied = applied.map { entry ->
                AppliedField(
                    field = entry.field,
                    value = entry.suggestion.value,
                    previousValue = existingValues[entry.field],
                    confidence = entry.suggestion.confidence,
                    source = entry.suggestion.source,
                )
            },
            lowConfidence = low,
            measurements = response.measurements.orEmpty(),
            // Measurements are all-or-nothing and applied by default: they're
            // brand-spec estimates, useful in bulk or not at all.
            measurementsApplied = !response.measurements.isNullOrEmpty(),
            conditionSummary = response.conditionSummary,
            usedLiveTextFallback = usedLiveTextFallback,
            ebayPending = response.ebayPending,
            researchRationale = response.research?.rationale,
            logId = response.logId,
            actionsRemaining = response.actionsRemaining,
        )
    }

    /**
     * Apply the two conflict rules. A conflicted field can NEVER auto-apply —
     * both rules cap confidence at [CONFLICT_CONFIDENCE], which is below the
     * bar, so anything the tag and the photos disagree on always reaches the
     * seller as an explicit choice.
     */
    private fun resolveConflicts(
        suggestions: Map<String, FieldSuggestion>,
        conflicts: List<FieldConflict>,
    ): List<FieldSuggestionEntry> {
        val byField = suggestions.mapValues { (field, suggestion) ->
            FieldSuggestionEntry(field, suggestion)
        }.toMutableMap()

        for (conflict in conflicts) {
            val field = conflict.field
            if (field in conflictReviewFields) {
                // US-1217: the tag wins outright. Injected even when there was
                // no suggestion for the field, because the tag reading is
                // evidence in its own right.
                val textValue = conflict.textValue?.takeIf { it.isNotBlank() } ?: continue
                byField[field] = FieldSuggestionEntry(
                    field = field,
                    suggestion = FieldSuggestion(
                        value = textValue,
                        confidence = CONFLICT_CONFIDENCE,
                        source = "conflict:tag",
                    ),
                )
            } else {
                // US-1530: keep the model's value but demote it, so a
                // disagreement never silently wins.
                val existing = byField[field] ?: continue
                byField[field] = existing.copy(
                    suggestion = existing.suggestion.copy(
                        confidence = minOf(existing.suggestion.confidence, CONFLICT_CONFIDENCE),
                        source = "conflict:photo",
                    ),
                )
            }
        }
        return byField.values.toList()
    }

    /**
     * A title seed that deliberately IGNORES the confidence bar.
     *
     * A capture with no readable tag would otherwise land on "Untitled item",
     * which is worse than a low-confidence guess the seller can edit.
     */
    fun bestTitleSeed(suggestions: Map<String, FieldSuggestion>): String? {
        suggestions["title"]?.value?.takeIf { it.isNotBlank() }?.let { return it }
        val brand = suggestions["brand"]?.value?.takeIf { it.isNotBlank() } ?: return null
        val qualifier = suggestions["style"]?.value?.takeIf { it.isNotBlank() }
            ?: suggestions["size"]?.value?.takeIf { it.isNotBlank() }
        return if (qualifier != null) "$brand $qualifier" else brand
    }

    /**
     * The acceptance signal posted back to `PATCH /ai/log/:id`.
     *
     * An UNDONE applied field is a correction, not an omission: the model
     * suggested something the seller actively rejected, and that is the most
     * valuable training signal in the whole flow. Dropping it would make the
     * log look like the AI was never wrong.
     */
    fun feedback(
        review: Review,
        keptApplied: Set<String>,
        acceptedLowConfidence: Set<String>,
    ): AiLogFeedback {
        val accepted = mutableMapOf<String, String>()
        val corrected = mutableMapOf<String, AiCorrection>()

        for (field in review.applied) {
            if (field.field in keptApplied) {
                accepted[field.field] = field.value
            } else {
                corrected[field.field] = AiCorrection(
                    suggested = field.value,
                    final = field.previousValue.orEmpty(),
                )
            }
        }
        for (entry in review.lowConfidence) {
            if (entry.field in acceptedLowConfidence) {
                accepted[entry.field] = entry.suggestion.value
            }
        }
        return AiLogFeedback(
            acceptedFields = accepted.ifEmpty { null },
            // Only send when non-empty: the server treats a supplied object as
            // authoritative, so an empty one would clobber prior corrections.
            correctedFields = corrected.ifEmpty { null },
        )
    }

    /**
     * The final field values to upsert onto the inventory item, with their
     * provenance. Unkept applied fields resolve to their undo target.
     */
    fun resolvedValues(
        review: Review,
        keptApplied: Set<String>,
        acceptedLowConfidence: Set<String>,
    ): Map<String, String> {
        val out = mutableMapOf<String, String>()
        for (field in review.applied) {
            out[field.field] =
                if (field.field in keptApplied) field.value else field.previousValue.orEmpty()
        }
        for (entry in review.lowConfidence) {
            if (entry.field in acceptedLowConfidence) out[entry.field] = entry.suggestion.value
        }
        return out
    }

    /** `ai_field_sources` for everything still AI-attributed after the review. */
    fun resolvedSources(
        review: Review,
        keptApplied: Set<String>,
        acceptedLowConfidence: Set<String>,
    ): Map<String, String> {
        val out = mutableMapOf<String, String>()
        review.applied.filter { it.field in keptApplied }
            .forEach { out[it.field] = it.source }
        review.lowConfidence.filter { it.field in acceptedLowConfidence }
            .forEach { out[it.field] = it.suggestion.source }
        return out
    }
}
