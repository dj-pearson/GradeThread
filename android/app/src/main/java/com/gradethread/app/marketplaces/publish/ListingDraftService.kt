package com.gradethread.app.marketplaces.publish

import com.gradethread.app.capture.CurrencyAmount
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.postgrest.from
import io.github.jan.supabase.postgrest.query.Columns
import io.github.jan.supabase.postgrest.query.Order
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import javax.inject.Inject
import javax.inject.Singleton

/**
 * US-1352: persists the composer's edits onto the item's eBay DRAFT listing row
 * before pre-flight runs.
 *
 * This exists because publish is server-driven: `/listings/validate` and
 * `/listings/push` both assemble what they send to eBay from the `listings`
 * row, NOT from anything the client posts. So an edit the seller made in the
 * composer has to be on that row first, or they would publish the old title at
 * the old price and be told the composer lied to them.
 *
 * The write goes through the anon client under RLS. `user_id` is filled by the
 * `set_listings_tenant` trigger from the parent item (migration 00146), which
 * is why it is deliberately NOT sent from here.
 */
@Singleton
class ListingDraftService @Inject constructor(
    private val client: SupabaseClient,
) {

    /** The composer's editable fields. */
    data class Draft(
        val title: String,
        val priceText: String,
        val condition: EbayCondition,
        val conditionDescription: String = "",
        /**
         * US-1353: listing-time item specifics (`item_specifics_override`).
         *
         * Null means the editor never loaded — leave the column alone. An EMPTY
         * MAP is different: it means the seller cleared every specific, and
         * writing null for that would resurrect the old override on the next
         * publish.
         */
        val specifics: Map<String, List<String>>? = null,
    )

    @Serializable
    private data class ListingRow(
        val id: String,
        val listing_status: String? = null,
        val listing_title: String? = null,
        val listing_price: Double? = null,
        val ebay_condition: String? = null,
        val ebay_condition_description: String? = null,
        val item_specifics_override: Map<String, List<String>>? = null,
    )

    companion object {
        private const val TABLE = "listings"

        /**
         * Parses the composer's price to a positive amount, or null.
         *
         * Null is a REFUSAL, not a zero: the old `toDouble() ?: 0` turned a
         * locale-formatted or garbled price into a $0 draft that could then be
         * published at $0 (the US-789 incident on web/iOS). Reuses
         * [CurrencyAmount] so the composer parses money exactly like every other
         * money field in the app.
         */
        fun validatedPrice(priceText: String): Double? =
            CurrencyAmount.parseCents(priceText)
                ?.takeIf { it > 0L }
                ?.let { it / 100.0 }

        /**
         * US-1353: `{ name: [values] }`, blanks dropped. An empty map encodes as
         * an empty object, NOT null — "the seller cleared them" has to be
         * distinguishable from "never edited".
         */
        internal fun encodeSpecifics(specifics: Map<String, List<String>>): JsonObject =
            JsonObject(
                specifics
                    .mapValues { (_, values) -> values.map { it.trim() }.filter { it.isNotEmpty() } }
                    .filterValues { it.isNotEmpty() }
                    .mapValues { (_, values) -> JsonArray(values.map { JsonPrimitive(it) }) },
            )

        /** A blank narrative means "clear it", which is a null, not an empty string. */
        internal fun nullableText(value: String) =
            value.trim().takeIf { it.isNotEmpty() }?.let { JsonPrimitive(it) } ?: JsonNull
    }

    /**
     * Writes the draft. Returns the price that was persisted so the caller can
     * estimate profit against the same number the server will publish.
     *
     * @throws IllegalArgumentException when the price isn't a positive amount.
     */
    suspend fun save(inventoryItemId: String, draft: Draft): Double {
        val price = validatedPrice(draft.priceText)
            ?: throw IllegalArgumentException("Enter a listing price greater than zero.")

        val fields = mutableMapOf<String, JsonElement>(
            "listing_price" to JsonPrimitive(price),
            "listing_title" to JsonPrimitive(draft.title.trim()),
            "ebay_condition" to JsonPrimitive(draft.condition.wire),
            "ebay_condition_description" to nullableText(draft.conditionDescription),
        )
        // US-1353: written as `{ name: [values] }`, the shape every edge
        // publish/revise consumer expects. A bare `{name: value}` throws in the
        // aspect-reconcile path and surfaces as a bogus "could not load eBay
        // specifics" blocker (the iOS US-1505 incident).
        draft.specifics?.let { fields["item_specifics_override"] = encodeSpecifics(it) }

        val existing = existingDraft(inventoryItemId)
        if (existing != null) {
            client.from(TABLE).update(JsonObject(fields)) { filter { eq("id", existing.id) } }
            return price
        }

        // Only the fields the composer owns are written on insert. Category,
        // policies and specifics are owned by other surfaces (US-1353), and
        // sending empty values for them here would overwrite an AutoLister draft
        // with blanks.
        fields["inventory_item_id"] = JsonPrimitive(inventoryItemId)
        fields["platform"] = JsonPrimitive("ebay")
        fields["listing_status"] = JsonPrimitive("draft")
        client.from(TABLE).insert(JsonObject(fields))
        return price
    }

    /**
     * The item's most recent eBay listing row, if it has one.
     *
     * Newest-first rather than "the active one": a previously ended listing is
     * still the row publish reads, and that is what relist re-uses.
     */
    suspend fun existingDraft(inventoryItemId: String): ListingSnapshot? =
        client.from(TABLE).select(
            Columns.raw(
                "id, listing_status, listing_title, listing_price, " +
                    "ebay_condition, ebay_condition_description, item_specifics_override",
            ),
        ) {
            filter {
                eq("inventory_item_id", inventoryItemId)
                eq("platform", "ebay")
            }
            order("created_at", Order.DESCENDING)
            limit(1)
        }.decodeList<ListingRow>().firstOrNull()?.let {
            ListingSnapshot(
                id = it.id,
                status = it.listing_status,
                title = it.listing_title,
                price = it.listing_price,
                condition = it.ebay_condition,
                conditionDescription = it.ebay_condition_description,
                specifics = it.item_specifics_override
                    ?.mapValues { (_, values) -> values.filter { v -> v.isNotBlank() } }
                    ?.filterValues { values -> values.isNotEmpty() }
                    .orEmpty(),
            )
        }

    /**
     * What the composer needs to know about an existing draft — including the
     * fields it prefills. A title the seller already tuned (or AutoLister wrote)
     * must survive reopening the composer; falling back to the raw item title
     * would quietly undo their edit.
     */
    data class ListingSnapshot(
        val id: String,
        val status: String?,
        val title: String? = null,
        val price: Double? = null,
        val condition: String? = null,
        val conditionDescription: String? = null,
        val specifics: Map<String, List<String>> = emptyMap(),
    ) {
        /**
         * Relist, not first publish: anything past draft has been on eBay, so
         * the server must end the old listing before minting a new one.
         */
        val needsRelist: Boolean get() = status != null && status != "draft"
    }
}
