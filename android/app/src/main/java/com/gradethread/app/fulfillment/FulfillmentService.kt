package com.gradethread.app.fulfillment

import com.gradethread.app.marketplaces.postsale.PostSaleService
import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.platform.workspace.WorkspaceScope
import io.github.jan.supabase.auth.auth
import com.gradethread.app.sync.MutationKind
import com.gradethread.app.sync.OfflineMutationQueue
import com.gradethread.app.sync.db.GradeThreadDb
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.postgrest.from
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.Instant
import javax.inject.Inject
import javax.inject.Singleton

/** What a mark-shipped attempt actually did. */
sealed class ShipOutcome {
    /** Written through, either to eBay or straight to the row. */
    data class Sent(val tracking: String?) : ShipOutcome()

    /** No connection — parked in the offline queue and mirrored locally. */
    data class Queued(val tracking: String?) : ShipOutcome()

    data class Failed(val message: String) : ShipOutcome()
}

/**
 * US-1377: marking a parcel on its way.
 *
 * Two paths, and which one runs is decided by [Fulfillment.goesToEbay]:
 *
 *  - an eBay order WITH tracking goes through the edge, which tells eBay and
 *    stamps `shipped_at` + `tracking_number` server-side in the same call, so
 *    this never double-writes;
 *  - anything else (a manual sale, another marketplace, or an eBay order with
 *    no tracking yet) writes the row directly under RLS.
 *
 * Either way the LOCAL row is stamped immediately, so the queue empties in front
 * of the seller rather than after the next pull.
 */
@Singleton
class FulfillmentService @Inject constructor(
    private val client: SupabaseClient,
    private val db: GradeThreadDb,
    private val queue: OfflineMutationQueue,
    private val postSale: PostSaleService,
) {

    companion object {
        const val TABLE = "sales"

        /** The queued payload: `{"id": …, "patch": { … }}`, like an item edit. */
        fun payload(saleId: String, shippedAtIso: String, tracking: String?): ByteArray {
            val patch = buildString {
                append("""{"shipped_at":"$shippedAtIso"""")
                // Omitted entirely when there is none, so a replay can't null
                // out a tracking number the server already has.
                if (tracking != null) append(""","tracking_number":"$tracking"""")
                append("}")
            }
            return """{"id":"$saleId","patch":$patch}""".encodeToByteArray()
        }
    }

    suspend fun markShipped(order: FulfillmentOrder, trackingText: String): ShipOutcome {
        val tracking = Fulfillment.trackingNumber(trackingText) ?: order.existingTracking
        val shippedAtMs = System.currentTimeMillis()
        val iso = Instant.ofEpochMilli(shippedAtMs).toString()

        val result = runCatching {
            if (Fulfillment.goesToEbay(order, tracking)) {
                postSale.markShipped(order.id, tracking!!)
            } else {
                writeRow(order.id, iso, tracking)
            }
        }

        result.onFailure { error ->
            if (!OfflineMutationQueue.shouldEnqueue(error)) {
                return ShipOutcome.Failed(
                    (error as? EdgeApiError)?.userMessage() ?: "Couldn't mark that shipped.",
                )
            }
            queue.enqueue(
                kind = MutationKind.MARK_SHIPPED,
                targetId = order.id,
                payload = payload(order.id, iso, tracking),
            )
            mirrorLocally(order.id, shippedAtMs, tracking)
            return ShipOutcome.Queued(tracking)
        }

        mirrorLocally(order.id, shippedAtMs, tracking)
        return ShipOutcome.Sent(tracking)
    }

    private fun ownerId(): String? =
        client.auth.currentUserOrNull()?.id?.let { WorkspaceScope.tenantOwnerId(it) }

    private suspend fun writeRow(saleId: String, iso: String, tracking: String?) {
        val fields = buildMap {
            put("shipped_at", JsonPrimitive(iso))
            if (tracking != null) put("tracking_number", JsonPrimitive(tracking))
        }
        client.from(TABLE).update(JsonObject(fields)) {
            filter {
                eq("id", saleId)
                // Tenant scope. RLS would refuse a foreign row anyway, but an
                // id from anywhere gets scoped before it reaches the database.
                ownerId()?.let { eq("user_id", it) }
            }
        }
    }

    /**
     * Stamp the cached row now.
     *
     * Without this the parcel stays in the queue until the next pull, and a
     * seller working through a pile would mark the same one twice.
     */
    private suspend fun mirrorLocally(saleId: String, shippedAtMs: Long, tracking: String?) {
        withContext(Dispatchers.IO) {
            val existing = db.sales().all().firstOrNull { it.id == saleId } ?: return@withContext
            db.sales().upsert(
                listOf(
                    existing.copy(
                        shippedAt = shippedAtMs,
                        trackingNumber = tracking ?: existing.trackingNumber,
                        // Dirty so a delta pull can't overwrite it before the
                        // queued write lands.
                        hasLocalChanges = true,
                    ),
                ),
            )
        }
    }
}
