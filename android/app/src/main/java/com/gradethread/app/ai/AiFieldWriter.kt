package com.gradethread.app.ai

import com.gradethread.app.platform.workspace.WorkspaceScope
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.postgrest.from
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import javax.inject.Inject
import javax.inject.Singleton

/**
 * US-1334 (AC3): persists a confirmed AI review onto `inventory_items`.
 *
 * Every statement is TENANT-SCOPED — `eq("id", …)` is always paired with
 * `eq("user_id", owner)`. The item id comes from the review, which came from
 * a response, so it must never be trusted on its own.
 */
@Singleton
class AiFieldWriter @Inject constructor(private val client: SupabaseClient) {

    /** Active workspace, else self — matching IntakeRepository. */
    private fun ownerId(): String? = client.auth.currentUserOrNull()?.id?.let { WorkspaceScope.tenantOwnerId(it) }

    /**
     * Apply the seller's confirmed review.
     *
     * @return the fields that were refused, so the caller can surface them
     * rather than let them vanish.
     */
    suspend fun apply(
        review: AiExtractReview.Review,
        keptApplied: Set<String>,
        acceptedLowConfidence: Set<String>,
        keepMeasurements: Boolean,
    ): Result<Map<String, String>> = runCatching {
        val owner = ownerId() ?: error("Not signed in")

        val values = AiExtractReview.resolvedValues(review, keptApplied, acceptedLowConfidence)
        val sources = AiExtractReview.resolvedSources(review, keptApplied, acceptedLowConfidence)
        val routed = AiItemFields.route(values)

        // Fields the seller undid are no longer AI-attributed, so their
        // provenance must go too — otherwise the item claims the AI set a
        // value the seller actually reverted.
        val undone = review.applied.map { it.field }.toSet() - keptApplied

        val current = loadCurrent(review.itemId, owner)

        val patch = buildMap<String, kotlinx.serialization.json.JsonElement> {
            routed.columns.forEach { (field, value) -> put(field, JsonPrimitive(value)) }
            // Cleared columns become NULL, not "": an empty string is a real
            // value that would show as a blank-but-set field downstream.
            routed.cleared.filter { it in AiItemFields.columnFields }
                .forEach { put(it, JsonNull) }

            if (routed.attributes.isNotEmpty() || routed.cleared.isNotEmpty()) {
                put(
                    "attributes",
                    JsonObject(
                        AiItemFields.mergeAttributes(
                            existing = current.attributes,
                            updates = routed.attributes,
                            cleared = routed.cleared,
                        ),
                    ),
                )
            }
            put(
                "ai_field_sources",
                JsonObject(
                    AiItemFields.mergeFieldSources(
                        existing = current.aiFieldSources,
                        sources = sources,
                        noLongerAiAttributed = undone,
                    ),
                ),
            )
            review.conditionSummary?.let { put("condition_summary", JsonPrimitive(it)) }
            if (keepMeasurements && review.measurements.isNotEmpty()) {
                put(
                    "measurements",
                    JsonObject(review.measurements.mapValues { JsonPrimitive(it.value) }),
                )
            }
        }

        if (patch.isNotEmpty()) {
            client.from(TABLE).update(JsonObject(patch)) {
                filter {
                    eq("id", review.itemId)
                    // Tenant scope. Never act on an id from a response alone.
                    eq("user_id", owner)
                }
            }
        }
        routed.rejected
    }

    /**
     * Replace the intake placeholder title with a seed from the extraction.
     *
     * The `title = replacing` filter is the whole point: extraction takes
     * ~40s, and the seller may have typed a real title in the meantime. A
     * read-then-write would race them and overwrite their words with a model
     * guess; a conditional UPDATE simply matches nothing in that case.
     */
    suspend fun seedTitle(itemId: String, seed: String, replacing: String): Result<Unit> = runCatching {
        val owner = ownerId() ?: error("Not signed in")
        if (seed.isBlank()) return@runCatching
        client.from(TABLE).update(
            JsonObject(mapOf("title" to JsonPrimitive(seed))),
        ) {
            filter {
                eq("id", itemId)
                // Tenant scope. Never act on an id from a response alone.
                eq("user_id", owner)
                eq("title", replacing)
            }
        }
        Unit
    }

    /**
     * Read the jsonb documents we're about to merge into.
     *
     * Required because a jsonb UPDATE replaces the whole document — writing
     * only new keys would delete the attributes the server gap-filled.
     */
    private suspend fun loadCurrent(itemId: String, owner: String): CurrentJsonb {
        val rows = client.from(TABLE).select {
            filter {
                eq("id", itemId)
                eq("user_id", owner)
            }
            limit(1)
        }.decodeList<AiItemRow>()
        return rows.firstOrNull()?.toCurrentJsonb() ?: CurrentJsonb()
    }

    private companion object {
        const val TABLE = "inventory_items"
    }
}

/**
 * The jsonb documents [AiFieldWriter] merges into, as read.
 *
 * US-3360: the values stay JSON. Only the keys an apply writes are replaced;
 * everything else is written back exactly as it came in.
 */
internal data class CurrentJsonb(
    val attributes: Map<String, JsonElement> = emptyMap(),
    val aiFieldSources: Map<String, JsonElement> = emptyMap(),
)

/**
 * US-3360: this used to be `it.value.toString().trim('"')` for both columns,
 * and the write re-emitted every entry as a JsonPrimitive. One Android apply
 * flattened the provenance objects edge, web and iOS wrote (confidence and
 * acceptance gone for good) and quoted every numeric or boolean attribute.
 */
internal fun AiItemRow.toCurrentJsonb(): CurrentJsonb = CurrentJsonb(
    attributes = attributes.orEmpty(),
    aiFieldSources = aiFieldSources.orEmpty(),
)

/** Narrow projection — only the jsonb documents the writer merges into. */
@Serializable
internal data class AiItemRow(
    val attributes: Map<String, kotlinx.serialization.json.JsonElement>? = null,
    @kotlinx.serialization.SerialName("ai_field_sources")
    val aiFieldSources: Map<String, kotlinx.serialization.json.JsonElement>? = null,
)
