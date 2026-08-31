package com.gradethread.app.marketplaces.reconciliation

import com.gradethread.app.ui.UiMessage

import com.gradethread.app.R

import androidx.annotation.StringRes

import com.gradethread.app.platform.workspace.WorkspaceScope
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.postgrest.from
import io.github.jan.supabase.postgrest.query.Columns
import io.github.jan.supabase.postgrest.query.Order
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.Instant
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * US-1356: matching orphan eBay listings to inventory.
 *
 * All Postgres, no edge: every write here is a plain row change RLS already
 * scopes to the owner. Reads and writes still name the tenant explicitly where
 * the table carries a `user_id`, matching the US-268 convention — a forged row
 * id alone must never flip another seller's listing.
 */
@Singleton
class ReconciliationService @Inject constructor(private val client: SupabaseClient) {

    companion object {
        private const val ORPHANS = "flipdesk_ebay_listings"
        private const val ITEMS = "inventory_items"
        private const val LISTINGS = "listings"

        private const val ORPHAN_COLUMNS =
            "id, ebay_item_id, custom_label, title, current_price, available_quantity, " +
                "listing_url, listing_format, imported_at"

        /**
         * Bounded fan-out for create-all. Each create is an independent
         * three-row write with no shared state, so a small overlap turns a
         * serial march into concurrent round-trips without flooding the pool.
         */
        const val BULK_CONCURRENCY = 4

        /** Ceiling for the banner's count read. */
        const val COUNT_CAP = 200

        val DUPLICATE_LISTING_MESSAGE =
            UiMessage(R.string.reconcile_error_duplicate_listing)
    }

    @Serializable
    private data class IdRow(val id: String)

    @Serializable
    private data class ActiveListingRow(val platform_listing_id: String? = null)

    private fun ownerId(): String? = client.auth.currentUserOrNull()?.id?.let { WorkspaceScope.tenantOwnerId(it) }

    /**
     * How many listings are waiting.
     *
     * Reads ID COLUMNS ONLY, bounded to [COUNT_CAP] + 1 rows. The banner needs a
     * number, not the data, and a seller with three thousand orphans should not
     * pull three thousand rows on every foreground to render one line of text.
     * Past the cap the banner says "200+", which is true — inventing an exact
     * total we didn't measure would not be.
     */
    suspend fun countOrphans(): OrphanCount {
        val owner = ownerId() ?: return OrphanCount()
        val rows = client.from(ORPHANS).select(Columns.raw("id")) {
            filter {
                eq("user_id", owner)
                eq("match_status", "unmatched")
            }
            limit((COUNT_CAP + 1).toLong())
        }.decodeList<IdRow>()
        return OrphanCount(
            value = minOf(rows.size, COUNT_CAP),
            atLeast = rows.size > COUNT_CAP,
        )
    }

    /** Every unmatched listing, newest import first. */
    suspend fun fetchOrphans(): List<OrphanEbayListing> {
        val owner = ownerId() ?: return emptyList()
        return client.from(ORPHANS).select(Columns.raw(ORPHAN_COLUMNS)) {
            filter {
                eq("user_id", owner)
                eq("match_status", "unmatched")
            }
            order("imported_at", Order.DESCENDING)
        }.decodeList()
    }

    /**
     * Mint an inventory item from the orphan and mark it matched.
     *
     * The id is generated CLIENT-side so the write is an idempotent upsert: a
     * retry after a lost response updates the same row instead of minting a
     * second item for one eBay listing.
     */
    suspend fun createItem(
        orphan: OrphanEbayListing,
        title: String? = null,
        sku: String? = null,
        targetPrice: Double? = null,
    ): ReconcileOutcome {
        val owner = ownerId()
            ?: return ReconcileOutcome.Failed(
                orphan.id,
                UiMessage(R.string.reconcile_error_signed_out),
            )
        val itemId = UUID.randomUUID().toString().lowercase()

        return runCatching {
            val fields = mutableMapOf(
                "id" to JsonPrimitive(itemId),
                "user_id" to JsonPrimitive(owner),
                "title" to JsonPrimitive(
                    title?.trim()?.takeIf { it.isNotEmpty() } ?: orphan.suggestedTitle,
                ),
                // eBay says this is live, so the item starts in `listed`. Leaving
                // it in a pre-list stage would offer a publish action that
                // double-lists it.
                "status" to JsonPrimitive("listed"),
            )
            val resolvedSku = sku?.trim()?.takeIf { it.isNotEmpty() }
                ?: orphan.customLabel?.trim()?.takeIf { it.isNotEmpty() }
            fields["sku"] = resolvedSku?.let { JsonPrimitive(it) } ?: JsonNull
            (targetPrice ?: orphan.currentPrice)?.let {
                fields["target_price"] = JsonPrimitive(it)
            }

            client.from(ITEMS).upsert(JsonObject(fields))
            // Best-effort mirror: a failure here must not strand a created item,
            // and the next eBay sync reconciles the listing row anyway.
            runCatching { mirrorListing(itemId, orphan) }
            markMatched(orphan.id, itemId, owner)
            ReconcileOutcome.Created(orphan.id, itemId)
        }.getOrElse { failed(orphan.id, it, R.string.reconcile_error_create) }
    }

    /**
     * Attach the orphan to an item the seller already has.
     *
     * Refuses when that item already carries a DIFFERENT active eBay listing:
     * that is how duplicate active rows are born, and every later bulk action
     * then has two rows to choose between. Re-linking the same listing is fine —
     * the mirror is idempotent.
     */
    suspend fun link(orphan: OrphanEbayListing, itemId: String): ReconcileOutcome {
        val owner = ownerId()
            ?: return ReconcileOutcome.Failed(
                orphan.id,
                UiMessage(R.string.reconcile_error_signed_out),
            )
        return runCatching {
            val active = client.from(LISTINGS)
                .select(Columns.raw("platform_listing_id")) {
                    filter {
                        eq("inventory_item_id", itemId)
                        eq("platform", "ebay")
                        eq("is_active", true)
                    }
                }.decodeList<ActiveListingRow>()

            if (active.any { it.platform_listing_id != null && it.platform_listing_id != orphan.ebayItemId }) {
                return ReconcileOutcome.Failed(orphan.id, DUPLICATE_LISTING_MESSAGE)
            }

            mirrorListing(itemId, orphan)
            markMatched(orphan.id, itemId, owner)
            // Same best-effort reasoning as the mirror on create.
            runCatching { markItemListed(itemId, owner) }
            ReconcileOutcome.Linked(orphan.id, itemId)
        }.getOrElse { failed(orphan.id, it, R.string.reconcile_error_link) }
    }

    /** Drop it from the queue. A re-sync can bring it back. */
    suspend fun ignore(orphan: OrphanEbayListing): ReconcileOutcome {
        val owner = ownerId()
            ?: return ReconcileOutcome.Failed(
                orphan.id,
                UiMessage(R.string.reconcile_error_signed_out),
            )
        return runCatching {
            client.from(ORPHANS).update(
                JsonObject(mapOf("match_status" to JsonPrimitive("ignored"))),
            ) {
                filter {
                    eq("id", orphan.id)
                    eq("user_id", owner)
                }
            }
            ReconcileOutcome.Ignored(orphan.id)
        }.getOrElse { failed(orphan.id, it, R.string.reconcile_error_ignore) }
    }

    /**
     * Create an item for every orphan, a few at a time.
     *
     * One bad row never stops the batch — the failures come back attached to
     * their orphans so the queue can show which ones still need a decision.
     * [onProgress] fires after each chunk so a long run isn't one opaque spinner.
     */
    suspend fun createAll(
        orphans: List<OrphanEbayListing>,
        onProgress: (done: Int, total: Int) -> Unit = { _, _ -> },
    ): ReconcileBulkResult = coroutineScope {
        val outcomes = mutableListOf<ReconcileOutcome>()
        for (chunk in orphans.chunked(BULK_CONCURRENCY)) {
            outcomes += chunk.map { async { createItem(it) } }.awaitAll()
            onProgress(outcomes.size, orphans.size)
        }
        ReconcileBulkResult.from(outcomes)
    }

    // ── Internals ────────────────────────────────────────────────────────────

    /**
     * Mirror the live eBay listing into `listings` so the item's canvas shows
     * where it is listed. Idempotent: updates the existing row for this
     * item + eBay id, else inserts one.
     *
     * `listed_at` is written only on INSERT — an update must not move the date
     * the listing actually went live.
     */
    private suspend fun mirrorListing(itemId: String, orphan: OrphanEbayListing) {
        val existing = client.from(LISTINGS).select(Columns.raw("id")) {
            filter {
                eq("inventory_item_id", itemId)
                eq("platform", "ebay")
                eq("platform_listing_id", orphan.ebayItemId)
            }
            limit(1)
        }.decodeList<IdRow>().firstOrNull()

        val shared = mutableMapOf(
            "platform" to JsonPrimitive("ebay"),
            // The listing was authored on eBay, so eBay owns its editable
            // fields from here (vault/20-domain/sync-source-of-truth.md).
            "listing_origin" to JsonPrimitive("ebay"),
            "listing_price" to JsonPrimitive(orphan.currentPrice ?: 0.0),
            "listing_status" to JsonPrimitive("active"),
            "is_active" to JsonPrimitive(true),
        )
        shared["listing_url"] = orphan.listingUrl?.let { JsonPrimitive(it) } ?: JsonNull
        shared["listing_title"] = orphan.title?.let { JsonPrimitive(it) } ?: JsonNull

        if (existing != null) {
            client.from(LISTINGS).update(JsonObject(shared)) {
                filter { eq("id", existing.id) }
            }
        } else {
            shared["inventory_item_id"] = JsonPrimitive(itemId)
            shared["platform_listing_id"] = JsonPrimitive(orphan.ebayItemId)
            shared["listed_at"] = JsonPrimitive(Instant.now().toString())
            client.from(LISTINGS).insert(JsonObject(shared))
        }
    }

    private suspend fun markMatched(orphanId: String, itemId: String, owner: String) {
        client.from(ORPHANS).update(
            JsonObject(
                mapOf(
                    "match_status" to JsonPrimitive("matched"),
                    "matched_item_id" to JsonPrimitive(itemId),
                ),
            ),
        ) {
            filter {
                eq("id", orphanId)
                eq("user_id", owner)
            }
        }
    }

    private suspend fun markItemListed(itemId: String, owner: String) {
        client.from(ITEMS).update(JsonObject(mapOf("status" to JsonPrimitive("listed")))) {
            filter {
                eq("id", itemId)
                eq("user_id", owner)
            }
        }
    }
}

/**
 * A reconcile failure: the thrown message when there is one, ours otherwise.
 *
 * US-2976: `it.message` is the exception's own words - a PostgREST error, a
 * socket timeout - and cannot be translated here, so it rides as `detail`.
 * Ours is the fallback shown when the throwable said nothing.
 */
private fun failed(orphanId: String, error: Throwable, @StringRes fallback: Int) =
    ReconcileOutcome.Failed(orphanId, UiMessage(fallback, detail = error.message))
