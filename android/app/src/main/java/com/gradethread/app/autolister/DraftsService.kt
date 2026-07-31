package com.gradethread.app.autolister

import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.postgrest.from
import io.github.jan.supabase.postgrest.query.Columns
import io.github.jan.supabase.postgrest.query.Order
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import javax.inject.Inject
import javax.inject.Singleton

/**
 * US-1359: the drafts library.
 *
 * Reads and writes `listings` rows directly under RLS, which scopes them to the
 * owner through the parent item. There is no edge route for this — a draft edit
 * is a plain column update, and routing it through the server would add a hop
 * without adding a rule.
 */
@Singleton
class DraftsService @Inject constructor(
    private val client: SupabaseClient,
) {

    companion object {
        private const val TABLE = "listings"
        private const val COLUMNS =
            "id, inventory_item_id, listing_title, listing_description, listing_price, " +
                "ebay_condition, quantity, batch_id, price_is_estimated, publish_error, " +
                "scheduled_publish_at, created_at"

        /** One request's ceiling, so a huge library can't stall the screen. */
        const val PAGE = 200
    }

    /** Unpublished drafts, newest first. */
    suspend fun drafts(batchId: String? = null): List<DraftListing> =
        client.from(TABLE).select(Columns.raw(COLUMNS)) {
            filter {
                eq("platform", "ebay")
                eq("listing_status", "draft")
                batchId?.let { eq("batch_id", it) }
            }
            order("created_at", Order.DESCENDING)
            limit(PAGE.toLong())
        }.decodeList()

    /**
     * Save one draft's edited fields.
     *
     * Only the fields that were actually edited are written. A null price means
     * "don't touch it", NOT "clear it" — clearing a price on a draft about to be
     * published would publish it at nothing.
     */
    suspend fun save(
        draftId: String,
        title: String? = null,
        description: String? = null,
        price: Double? = null,
        condition: String? = null,
    ) {
        val fields = mutableMapOf<String, kotlinx.serialization.json.JsonElement>()
        title?.let { fields["listing_title"] = JsonPrimitive(it.trim()) }
        description?.let {
            // A cleared description IS meaningful — it's a field the seller can
            // legitimately empty — so blank writes null rather than being dropped.
            fields["listing_description"] = it.trim().takeIf { t -> t.isNotEmpty() }
                ?.let { t -> JsonPrimitive(t) } ?: JsonNull
        }
        price?.let { fields["listing_price"] = JsonPrimitive(it) }
        condition?.let { fields["ebay_condition"] = JsonPrimitive(it) }
        if (fields.isEmpty()) return

        client.from(TABLE).update(JsonObject(fields)) { filter { eq("id", draftId) } }
    }

    /**
     * Apply one price change across a selection.
     *
     * Sequential rather than one statement: each draft's new price depends on
     * its OWN current price, and the drafts a change can't apply to are skipped
     * rather than zeroed. Returns how many actually moved.
     */
    suspend fun bulkPrice(
        drafts: List<DraftListing>,
        selected: Set<String>,
        change: DraftBulk.PriceChange,
    ): Int {
        var updated = 0
        for (draft in drafts.filter { it.id in selected }) {
            val price = DraftBulk.newPrice(draft.listingPrice, change) ?: continue
            save(draft.id, price = price)
            updated += 1
        }
        return updated
    }

    /** Apply the same text to every selected draft. */
    suspend fun bulkText(
        selected: Set<String>,
        title: String? = null,
        description: String? = null,
    ): Int {
        if (title == null && description == null) return 0
        var updated = 0
        for (id in selected) {
            save(id, title = title, description = description)
            updated += 1
        }
        return updated
    }

    /**
     * US-1361: set or clear a draft's scheduled publish time.
     *
     * [instantIso] is UTC — the column is, and the publish-due cron compares it
     * against server time. Null CLEARS the schedule, leaving the draft a draft;
     * that is a real action, not an omission, so it writes null rather than
     * being skipped.
     */
    suspend fun schedule(draftId: String, instantIso: String?) {
        client.from(TABLE).update(
            JsonObject(
                mapOf(
                    "scheduled_publish_at" to (
                        instantIso?.let { JsonPrimitive(it) } ?: JsonNull
                        ),
                ),
            ),
        ) {
            filter { eq("id", draftId) }
        }
    }

    /**
     * Delete a draft.
     *
     * The draft only — the inventory item it belongs to stays. A seller
     * discarding a generated listing is not asking to lose the item.
     */
    suspend fun delete(draftId: String) {
        client.from(TABLE).delete { filter { eq("id", draftId) } }
    }
}
