package com.gradethread.app.inventory

import com.gradethread.app.capture.CurrencyAmount
import com.gradethread.app.capture.DetailsIntakeState
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * US-1330: saving a details-intake form. Pure over injected IO seams (the
 * `SyncPull` pattern) so every rule below unit-tests without a network:
 *
 *  - the duplicate SKU is PRE-CHECKED, not recovered from. iOS looks the SKU
 *    up before inserting because on intake there is no row yet — so "merge"
 *    is a plain UPDATE of the existing item, and the `merge_inventory_items`
 *    RPC (which re-points children of a survivor) does NOT apply;
 *  - a merge PATCH omits nil keys entirely. Sending JSON null would WIPE the
 *    existing item's columns — the opposite of "combine";
 *  - STATUS and SKU are never merged: re-cataloging must not regress a
 *    listed/sold item, and the SKU is what they already agree on;
 *  - offline is decided by TYPED error classification, never by matching
 *    English in a message (US-1004).
 */
object IntakeSubmission {

    /** The columns a merge can reconcile, read off the existing row. */
    data class ExistingItem(
        val id: String,
        val title: String? = null,
        val brand: String? = null,
        val style: String? = null,
        val size: String? = null,
        val color: String? = null,
        val material: String? = null,
        val itemCategory: String? = null,
        val status: String? = null,
        val container: String? = null,
        val sourcedBy: String? = null,
        val acquiredDate: String? = null,
        val acquiredPrice: String? = null,
        val description: String? = null,
    )

    sealed class Outcome {
        /** Inserted server-side. */
        data class Inserted(val itemId: String) : Outcome()

        /** Offline: a pending mutation was queued and will replay as an upsert. */
        data class Queued(val itemId: String) : Outcome()

        /** The SKU is taken — the caller presents the combine sheet. */
        data class MergeRequired(
            val existing: ExistingItem,
            val conflicts: List<ItemMergePlan.Conflict>,
        ) : Outcome()

        data class Failed(val error: Throwable) : Outcome()
    }

    /**
     * The insert body. Empty strings become NULL (not `""`) so the downstream
     * `IS NULL` filters and the partial SKU index behave — a `""` SKU would
     * occupy the unique index and collide with the next blank-SKU item.
     */
    fun insertPayload(
        state: DetailsIntakeState,
        ownerId: String,
        itemId: String,
    ): JsonObject = buildJsonObject {
        // Client-minted and LOWERCASED: Postgres normalizes uuids, and a
        // case-mismatched id caused duplicate-item sync bugs on iOS.
        put("id", itemId.lowercase())
        put("user_id", ownerId)
        put("title", state.title.trim())
        putIfPresent("sku", state.sku)
        putIfPresent("brand", state.brand)
        putIfPresent("style", state.style)
        putIfPresent("size", state.size)
        putIfPresent("color", state.color)
        putIfPresent("material", state.material)
        put("item_category", state.category)
        put("status", state.status)
        putIfPresent("source_id", state.sourceId)
        putIfPresent("container", state.container)
        putIfPresent("sourced_by", state.sourcedBy)
        // A Postgres DATE — `YYYY-MM-DD` only, never a timestamp.
        putIfPresent("acquired_date", state.purchaseDate)
        CurrencyAmount.toWire(state.purchasePriceText)?.let { put("acquired_price", it) }
        // Intake notes map to `description`, NOT `condition_notes`.
        putIfPresent("description", state.notes)
    }

    /**
     * The merge body: gap-fill the existing row from the form, plus any field
     * the user explicitly chose to overwrite. Only keys that should CHANGE
     * appear — an absent key leaves the column untouched.
     *
     * [keepExisting] names the fields where the user kept the existing value,
     * so those are omitted even when the form has something.
     */
    fun mergePatch(
        state: DetailsIntakeState,
        existing: ExistingItem,
        keepExisting: Set<ItemMergePlan.Field>,
    ): JsonObject {
        fun resolve(
            field: ItemMergePlan.Field,
            formValue: String?,
            existingValue: String?,
        ): String? {
            if (field in keepExisting) return null
            val form = formValue?.trim().orEmpty()
            if (form.isEmpty()) return null
            // Gap-fill: take the form value when the existing column is blank,
            // or when the user chose the typed value over a real conflict.
            val hasExisting = !existingValue.isNullOrBlank()
            return if (!hasExisting || form.lowercase() != existingValue!!.trim().lowercase()) {
                form
            } else {
                null
            }
        }

        return buildJsonObject {
            resolve(ItemMergePlan.Field.TITLE, state.title, existing.title)
                ?.let { put("title", it) }
            resolve(ItemMergePlan.Field.BRAND, state.brand, existing.brand)
                ?.let { put("brand", it) }
            resolve(ItemMergePlan.Field.STYLE, state.style, existing.style)
                ?.let { put("style", it) }
            resolve(ItemMergePlan.Field.SIZE, state.size, existing.size)
                ?.let { put("size", it) }
            resolve(ItemMergePlan.Field.COLOR, state.color, existing.color)
                ?.let { put("color", it) }
            resolve(ItemMergePlan.Field.MATERIAL, state.material, existing.material)
                ?.let { put("material", it) }
            resolve(ItemMergePlan.Field.CATEGORY, state.category, existing.itemCategory)
                ?.let { put("item_category", it) }
            resolve(ItemMergePlan.Field.CONTAINER, state.container, existing.container)
                ?.let { put("container", it) }
            resolve(ItemMergePlan.Field.SOURCED_BY, state.sourcedBy, existing.sourcedBy)
                ?.let { put("sourced_by", it) }
            resolve(ItemMergePlan.Field.ACQUIRED_DATE, state.purchaseDate, existing.acquiredDate)
                ?.let { put("acquired_date", it) }
            resolve(ItemMergePlan.Field.DESCRIPTION, state.notes, existing.description)
                ?.let { put("description", it) }
            // Money compares as cents so "12" vs "12.00" is not a change.
            if (ItemMergePlan.Field.ACQUIRED_PRICE !in keepExisting) {
                val form = CurrencyAmount.parseCents(state.purchasePriceText)
                val ex = CurrencyAmount.parseCents(existing.acquiredPrice)
                if (form != null && form != ex) put("acquired_price", CurrencyAmount.formatRaw(form))
            }
            // STATUS and SKU are deliberately absent — see the class doc.
        }
    }

    /** The conflict table shown in the combine sheet. */
    fun conflictsFor(
        state: DetailsIntakeState,
        existing: ExistingItem,
    ): List<ItemMergePlan.Conflict> {
        val current = mapOf(
            ItemMergePlan.Field.TITLE to ItemMergePlan.Value.text(state.title),
            ItemMergePlan.Field.BRAND to ItemMergePlan.Value.text(state.brand),
            ItemMergePlan.Field.STYLE to ItemMergePlan.Value.text(state.style),
            ItemMergePlan.Field.SIZE to ItemMergePlan.Value.text(state.size),
            ItemMergePlan.Field.COLOR to ItemMergePlan.Value.text(state.color),
            ItemMergePlan.Field.MATERIAL to ItemMergePlan.Value.text(state.material),
            ItemMergePlan.Field.CATEGORY to ItemMergePlan.Value.text(state.category),
            ItemMergePlan.Field.CONTAINER to ItemMergePlan.Value.text(state.container),
            ItemMergePlan.Field.SOURCED_BY to ItemMergePlan.Value.text(state.sourcedBy),
            ItemMergePlan.Field.ACQUIRED_DATE to ItemMergePlan.Value.text(state.purchaseDate),
            ItemMergePlan.Field.ACQUIRED_PRICE to ItemMergePlan.Value.money(state.purchasePriceText),
            ItemMergePlan.Field.DESCRIPTION to ItemMergePlan.Value.text(state.notes),
        )
        val other = mapOf(
            ItemMergePlan.Field.TITLE to ItemMergePlan.Value.text(existing.title),
            ItemMergePlan.Field.BRAND to ItemMergePlan.Value.text(existing.brand),
            ItemMergePlan.Field.STYLE to ItemMergePlan.Value.text(existing.style),
            ItemMergePlan.Field.SIZE to ItemMergePlan.Value.text(existing.size),
            ItemMergePlan.Field.COLOR to ItemMergePlan.Value.text(existing.color),
            ItemMergePlan.Field.MATERIAL to ItemMergePlan.Value.text(existing.material),
            ItemMergePlan.Field.CATEGORY to ItemMergePlan.Value.text(existing.itemCategory),
            ItemMergePlan.Field.CONTAINER to ItemMergePlan.Value.text(existing.container),
            ItemMergePlan.Field.SOURCED_BY to ItemMergePlan.Value.text(existing.sourcedBy),
            ItemMergePlan.Field.ACQUIRED_DATE to ItemMergePlan.Value.text(existing.acquiredDate),
            ItemMergePlan.Field.ACQUIRED_PRICE to ItemMergePlan.Value.money(existing.acquiredPrice),
            ItemMergePlan.Field.DESCRIPTION to ItemMergePlan.Value.text(existing.description),
        )
        // Status never appears: a re-catalog must not regress a listed item.
        return ItemMergePlan.conflicts(current, other)
            .filter { it.field != ItemMergePlan.Field.STATUS }
    }

    /**
     * Save the form.
     *
     * @param findBySku returns the item already holding this SKU, or null. A
     *   LOOKUP FAILURE must return null so a flaky read degrades to a normal
     *   insert (which the unique index still protects) rather than blocking.
     * @param insert performs the server insert; throws on failure.
     * @param shouldQueue typed offline classification (OfflineMutationQueue.shouldEnqueue).
     * @param enqueue queues the pending mutation for replay.
     */
    suspend fun submit(
        state: DetailsIntakeState,
        ownerId: String,
        itemId: String,
        findBySku: suspend (sku: String) -> ExistingItem?,
        insert: suspend (JsonObject) -> Unit,
        shouldQueue: (Throwable) -> Boolean,
        enqueue: suspend (itemId: String, payload: JsonObject) -> Unit,
    ): Outcome {
        val sku = state.sku.trim()
        if (sku.isNotEmpty()) {
            val existing = runCatching { findBySku(sku) }.getOrNull()
            if (existing != null) {
                return Outcome.MergeRequired(existing, conflictsFor(state, existing))
            }
        }
        val payload = insertPayload(state, ownerId, itemId)
        return try {
            insert(payload)
            Outcome.Inserted(itemId.lowercase())
        } catch (t: Throwable) {
            if (shouldQueue(t)) {
                // The payload already carries the lowercased client id, so a
                // replay UPSERTs the same row instead of duplicating it.
                enqueue(itemId.lowercase(), payload)
                Outcome.Queued(itemId.lowercase())
            } else {
                Outcome.Failed(t)
            }
        }
    }

    /** Put only when non-blank — an absent key means NULL, never `""`. */
    private fun kotlinx.serialization.json.JsonObjectBuilder.putIfPresent(
        key: String,
        value: String?,
    ) {
        val trimmed = value?.trim().orEmpty()
        if (trimmed.isNotEmpty()) put(key, trimmed)
    }
}
