package com.gradethread.app.inventory

import com.gradethread.app.capture.CurrencyAmount
import com.gradethread.app.capture.FlipdeskCategory
import com.gradethread.app.sync.db.InventoryItemEntity
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * US-1343: the editable snapshot of an `inventory_items` row.
 *
 * A value type, so the canvas can diff a draft against the snapshot it was
 * seeded from without holding two live Room entities. Everything numeric is
 * boxed as text while editing — a seller typing "12." must not be reinterpreted
 * mid-keystroke.
 */
data class ItemDraft(
    val title: String = "",
    val brand: String = "",
    val sku: String = "",
    val size: String = "",
    val color: String = "",
    val material: String = "",
    val style: String = "",
    val status: String = "cataloged",
    /**
     * NULLABLE on purpose. `FlipdeskCategory.from()` falls back to CLOTHING for
     * an unknown value, which is right for a picker default and WRONG here: a
     * photo-first item is created with no category at all, and seeding it to
     * clothing would have the first save silently assert a category the seller
     * never chose — on a watch, say.
     */
    val category: FlipdeskCategory? = null,
    val garmentType: String = "",
    val garmentCategory: String = "",
    val description: String = "",
    val conditionNotes: String = "",
    val sourcedBy: String = "",
    val container: String = "",
    val locationBin: String = "",
    /** Epoch millis; a Postgres DATE, so only the calendar day is written. */
    val acquiredDate: Long? = null,
    val acquiredPriceText: String = "",
    val targetPriceText: String = "",
    val consignorId: String? = null,
    /** 0–100 as typed; "" means "use the consignor's default". */
    val consignmentSplitText: String = "",
    /** US-1345: canonical key → value, decoded from the `measurements` jsonb. */
    val measurements: Map<String, Double> = emptyMap(),
    /** US-1346: the seller's own saved comparable sales (`comp_set` jsonb). */
    val comps: List<ItemComp> = emptyList(),
    /** US-1347: the resolved eBay leaf category for this item's specifics. */
    val ebayCategoryId: String? = null,
    /** US-1347: `ebay_aspects` — aspect name → values. */
    val aspects: Map<String, List<String>> = emptyMap(),
    /** US-1347: the parallel provenance map (00184). */
    val aspectSources: Map<String, AspectSync.Provenance> = emptyMap(),
) {

    /** Garment classification only applies to clothing. */
    val showsGarmentFields: Boolean get() = category == FlipdeskCategory.CLOTHING

    companion object {

        fun from(item: InventoryItemEntity): ItemDraft = ItemDraft(
            title = item.title,
            brand = item.brand.orEmpty(),
            sku = item.sku.orEmpty(),
            size = item.size.orEmpty(),
            color = item.color.orEmpty(),
            material = item.material.orEmpty(),
            style = item.style.orEmpty(),
            status = item.status,
            // Nullable seed — see the property doc.
            category = categoryOrNull(item.itemCategory),
            garmentType = item.garmentType.orEmpty(),
            garmentCategory = item.garmentCategory.orEmpty(),
            description = item.itemDescription.orEmpty(),
            conditionNotes = item.conditionNotes.orEmpty(),
            sourcedBy = item.sourcedBy.orEmpty(),
            container = item.container.orEmpty(),
            locationBin = item.locationBin.orEmpty(),
            acquiredDate = item.acquiredDate,
            acquiredPriceText = CurrencyAmount.formatRaw(item.acquiredPrice?.let { toCents(it) }),
            targetPriceText = CurrencyAmount.formatRaw(item.targetPrice?.let { toCents(it) }),
            consignorId = item.consignorId,
            consignmentSplitText = item.consignmentSplitPct
                ?.let { CurrencyAmount.formatRaw(toCents(it)) }
                .orEmpty(),
            measurements = MeasurementCatalog.decode(item.measurementsJson),
            comps = CompSet.decode(item.compSetJson),
            ebayCategoryId = item.ebayCategoryId,
            aspects = AspectSync.decodeAspects(item.ebayAspectsJson),
            aspectSources = AspectSync.decodeSources(item.ebayAspectSourcesJson),
        )

        /** Strict lookup: an absent or unrecognized value stays null. */
        fun categoryOrNull(wire: String?): FlipdeskCategory? =
            wire?.takeIf { it.isNotBlank() }
                ?.let { value -> FlipdeskCategory.entries.firstOrNull { it.wire == value } }

        private fun toCents(value: Double): Long = Math.round(value * 100)

        /** `YYYY-MM-DD` — a Postgres DATE, never a timestamp. */
        fun toDateWire(epochMillis: Long?): String? = epochMillis?.let {
            java.time.Instant.ofEpochMilli(it)
                .atZone(java.time.ZoneId.systemDefault())
                .toLocalDate()
                .toString()
        }
    }
}

/**
 * Turning an edited draft into a write.
 *
 * Kept separate and pure because two rules here are easy to get wrong and
 * expensive when they are.
 */
object ItemPatch {

    /**
     * Terminal states an item must not silently regress from. A row that has
     * sold cannot go back to `cataloged` because a stale canvas was open.
     */
    val TERMINAL_STATES = setOf("sold", "shipped", "completed", "returned", "archived")

    fun allowsStatus(current: String, next: String): Boolean =
        current == next || !(current in TERMINAL_STATES && next !in TERMINAL_STATES)

    /**
     * The columns that actually CHANGED between [original] and [edited].
     *
     * Only changed keys are emitted, which matters more than it looks: the
     * canvas holds a snapshot taken when it opened, and a full-row write would
     * push every stale field back over anything that changed in between — a
     * grade that landed, a price a sync pulled, a field another device edited.
     * This is the same class of bug as the publish-time listing snapshots.
     *
     * A field cleared to blank becomes JSON null, never "": an empty string is
     * a real value that reads as set-but-empty downstream, and it would occupy
     * the partial unique index on `sku`.
     */
    fun diff(original: ItemDraft, edited: ItemDraft): JsonObject {
        val patch = mutableMapOf<String, JsonElement>()

        fun text(column: String, before: String, after: String) {
            if (before.trim() == after.trim()) return
            patch[column] = after.trim().takeIf { it.isNotEmpty() }
                ?.let { JsonPrimitive(it) } ?: JsonNull
        }

        text("title", original.title, edited.title)
        text("brand", original.brand, edited.brand)
        text("sku", original.sku, edited.sku)
        text("size", original.size, edited.size)
        text("color", original.color, edited.color)
        text("material", original.material, edited.material)
        text("style", original.style, edited.style)
        text("garment_type", original.garmentType, edited.garmentType)
        text("garment_category", original.garmentCategory, edited.garmentCategory)
        text("description", original.description, edited.description)
        text("condition_notes", original.conditionNotes, edited.conditionNotes)
        text("sourced_by", original.sourcedBy, edited.sourcedBy)
        text("container", original.container, edited.container)
        text("location_bin", original.locationBin, edited.locationBin)

        // Title is NOT NULL server-side, so a blank title is a no-op rather
        // than a write that fails the whole patch.
        if (patch["title"] is JsonNull) patch.remove("title")

        if (original.category != edited.category) {
            // Only written when it actually changed, so an item that never had
            // a category keeps not having one (AC3).
            patch["item_category"] = edited.category?.let { JsonPrimitive(it.wire) } ?: JsonNull
        }

        if (original.status != edited.status && allowsStatus(original.status, edited.status)) {
            patch["status"] = JsonPrimitive(edited.status)
        }

        if (original.acquiredDate != edited.acquiredDate) {
            patch["acquired_date"] = ItemDraft.toDateWire(edited.acquiredDate)
                ?.let { JsonPrimitive(it) } ?: JsonNull
        }

        money("acquired_price", original.acquiredPriceText, edited.acquiredPriceText, patch)
        money("target_price", original.targetPriceText, edited.targetPriceText, patch)
        money(
            "consignment_split_pct",
            original.consignmentSplitText,
            edited.consignmentSplitText,
            patch,
        )

        if (original.measurements != edited.measurements) {
            // The whole document is replaced, because a jsonb UPDATE replaces
            // it anyway — sending only the changed keys would silently delete
            // every measurement the seller did not touch this session.
            patch["measurements"] = MeasurementCatalog.encode(edited.measurements)
                ?.let { kotlinx.serialization.json.Json.parseToJsonElement(it) }
                ?: JsonNull
        }

        if (original.comps != edited.comps) {
            // Whole-document replace, same rule as measurements: a jsonb UPDATE
            // replaces it anyway, so a partial write would drop the comps the
            // seller didn't touch.
            patch["comp_set"] = CompSet.encode(edited.comps)
                ?.let { kotlinx.serialization.json.Json.parseToJsonElement(it) }
                ?: JsonNull
        }

        // US-1347: the columns own their aspects, so the projection runs on
        // EVERY save — otherwise a brand edit here and the Brand specific that
        // publishes to eBay drift apart silently.
        // Compared against the ORIGINAL'S PROJECTION, not against its stored
        // aspects. An item can carry a brand with no Brand specific yet, and
        // comparing to the stored map would make that difference show up on
        // every open — leaving the canvas permanently "dirty" and writing
        // aspects nobody edited. Comparing projection to projection means the
        // backfill rides along with a real edit instead.
        val (originalProjected, originalSources) = AspectSync.projectColumnAspects(
            original,
            original.aspects,
            original.aspectSources,
        )
        val (projected, projectedSources) = AspectSync.projectColumnAspects(
            edited,
            edited.aspects,
            edited.aspectSources,
        )
        val prunedSources = AspectSync.pruneSources(projectedSources, projected)
        val originalPruned = AspectSync.pruneSources(originalSources, originalProjected)
        if (projected != originalProjected) {
            patch["ebay_aspects"] = AspectSync.encodeAspects(projected)
                ?.let { kotlinx.serialization.json.Json.parseToJsonElement(it) }
                ?: JsonNull
        }
        if (prunedSources != originalPruned) {
            patch["ebay_aspect_sources"] = AspectSync.encodeSources(prunedSources)
                ?.let { kotlinx.serialization.json.Json.parseToJsonElement(it) }
                ?: JsonNull
        }
        if (original.ebayCategoryId != edited.ebayCategoryId) {
            patch["ebay_category_id"] = edited.ebayCategoryId?.takeIf { it.isNotBlank() }
                ?.let { JsonPrimitive(it) } ?: JsonNull
        }

        if (original.consignorId != edited.consignorId) {
            patch["consignor_id"] = edited.consignorId?.takeIf { it.isNotBlank() }
                ?.let { JsonPrimitive(it) } ?: JsonNull
        }

        return JsonObject(patch)
    }

    /**
     * Money compares as CENTS, so "12" and "12.00" are not a change.
     *
     * Without this every re-open of the canvas would dirty the price fields
     * purely by reformatting them, and every save would write values nobody
     * touched.
     */
    private fun money(
        column: String,
        before: String,
        after: String,
        patch: MutableMap<String, JsonElement>,
    ) {
        val beforeCents = CurrencyAmount.parseCents(before)
        val afterCents = CurrencyAmount.parseCents(after)
        if (beforeCents == afterCents) return
        patch[column] = afterCents
            ?.let { JsonPrimitive(CurrencyAmount.formatRaw(it).toDouble()) }
            ?: JsonNull
    }

    /** Whether anything at all would be written. */
    fun isDirty(original: ItemDraft, edited: ItemDraft): Boolean =
        diff(original, edited).isNotEmpty()
}
