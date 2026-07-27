package com.gradethread.app.sync

import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.sync.db.PendingMutationEntity
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The replay planner (US-1319's missing half).
 *
 * `OfflineMutationQueue.drain()` had no production caller, so every offline
 * edit sat in `pending_mutations` forever. These cases pin the mapping that
 * turns those payloads back into writes — in particular the two properties that
 * make replay safe to run repeatedly:
 *
 *  - every create is an UPSERT (the original insert may have landed and only
 *    its response been lost, and a plain insert would then mark a good row stuck);
 *  - the tenant is re-stamped from the CURRENT owner, never read from the
 *    payload, so a queued row that predates a workspace switch cannot replay
 *    into the wrong tenant.
 */
class MutationReplayPlanTest {

    private val owner = "owner-1"

    private fun mutation(
        kind: MutationKind,
        payload: String,
        targetId: String? = null,
    ) = PendingMutationEntity(
        id = "m1",
        kind = kind.wire,
        payload = payload.encodeToByteArray(),
        targetId = targetId,
        lastError = null,
        lastAttemptAt = null,
        createdAt = 0L,
    )

    private fun string(write: MutationReplayPlan.Write.Upsert, key: String): String? =
        (write.body[key] as? JsonPrimitive)?.contentOrNull

    // ── Item create ──────────────────────────────────────────────────────────

    @Test
    fun itemCreateUpsertsTheOriginalInsertBody() {
        val write = MutationReplayPlan.plan(
            mutation(
                MutationKind.CREATE_INVENTORY_ITEM,
                """{"id":"i1","user_id":"$owner","title":"Wool coat","status":"cataloged"}""",
            ),
            owner,
        )
        // Upsert, not insert: replay must be idempotent.
        val upsert = write as MutationReplayPlan.Write.Upsert
        assertEquals(MutationReplayPlan.ITEMS, upsert.table)
        assertEquals("i1", string(upsert, "id"))
        assertEquals("Wool coat", string(upsert, "title"))
    }

    @Test
    fun itemCreateRestampsTheTenantRatherThanTrustingThePayload() {
        // A row enqueued under a workspace the seller has since left must not
        // replay into it. The payload's user_id is STALE by definition.
        val write = MutationReplayPlan.plan(
            mutation(
                MutationKind.CREATE_INVENTORY_ITEM,
                """{"id":"i1","user_id":"stale-workspace","title":"X"}""",
            ),
            owner,
        ) as MutationReplayPlan.Write.Upsert
        assertEquals(owner, string(write, "user_id"))
    }

    // ── Item update ──────────────────────────────────────────────────────────

    @Test
    fun itemUpdateCarriesThePatchAndTheTenantFilter() {
        val write = MutationReplayPlan.plan(
            mutation(
                MutationKind.UPDATE_INVENTORY_ITEM,
                """{"id":"i1","patch":{"title":"Renamed","listing_price":42.5}}""",
            ),
            owner,
        ) as MutationReplayPlan.Write.Update
        assertEquals(MutationReplayPlan.ITEMS, write.table)
        assertEquals("i1", write.id)
        assertEquals(owner, write.userId)
        assertEquals(2, write.patch.size)
    }

    @Test
    fun anEmptyPatchIsPlannedNotRejected() {
        // Failing it would pin a harmless row to stuck forever; the executor
        // simply sends nothing.
        val write = MutationReplayPlan.plan(
            mutation(MutationKind.UPDATE_INVENTORY_ITEM, """{"id":"i1","patch":{}}"""),
            owner,
        ) as MutationReplayPlan.Write.Update
        assertTrue(write.patch.isEmpty())
    }

    @Test
    fun anUpdateWithNoPatchObjectIsTerminal() {
        val error = runCatching {
            MutationReplayPlan.plan(
                mutation(MutationKind.UPDATE_INVENTORY_ITEM, """{"id":"i1"}"""),
                owner,
            )
        }.exceptionOrNull()
        // BadRequest is what OfflineMutationQueue.isTerminal reads as "stop" —
        // retrying a malformed payload six times helps nobody.
        assertTrue(error is EdgeApiError.BadRequest)
        assertTrue(OfflineMutationQueue.isTerminal(error!!))
    }

    // ── Photo rows ───────────────────────────────────────────────────────────

    @Test
    fun photoRowUsesTheLocalUrlRatherThanRebuildingIt() {
        // The worker resolved the URL against the bucket it actually uploaded
        // to; re-deriving it here could point the row at the wrong bucket.
        val write = MutationReplayPlan.plan(
            mutation(
                MutationKind.UPLOAD_PHOTO,
                """{"photo_id":"p1","inventory_item_id":"i1","photo_type":"front",
                   "storage_path":"u/i1/front_1.jpg","sort_order":2,"captured_at":5}""",
            ),
            owner,
            MutationReplayPlan.PhotoHints(
                photoUrl = "https://storage/item-photos/u/i1/front_1.jpg",
                sortOrder = 2,
                width = 800,
                height = 600,
                bytes = 1234,
            ),
        ) as MutationReplayPlan.Write.Upsert

        assertEquals(MutationReplayPlan.PHOTOS, write.table)
        assertEquals("p1", string(write, "id"))
        assertEquals("front", string(write, "photo_type"))
        assertEquals("https://storage/item-photos/u/i1/front_1.jpg", string(write, "photo_url"))
        assertEquals(2, (write.body["sort_order"] as? JsonPrimitive)?.intOrNull)
        // item_photos has no user_id: ownership is via the parent item's FK.
        assertNull(write.body["user_id"])
    }

    @Test
    fun aStuckUploadPayloadIsTerminalRatherThanPublishedAsAPhoto() {
        // UploadWorker.queueStuckMutation writes {"photo_id","error"} for an
        // upload that NEVER happened. Replaying it would publish a row pointing
        // at bytes that were never stored.
        val error = runCatching {
            MutationReplayPlan.plan(
                mutation(MutationKind.UPLOAD_PHOTO, """{"photo_id":"p1","error":"upload failed"}"""),
                owner,
            )
        }.exceptionOrNull()
        assertTrue(error is EdgeApiError.BadRequest)
        assertTrue(OfflineMutationQueue.isTerminal(error!!))
    }

    @Test
    fun photoRowSurvivesAMissingLocalRow() {
        // No hints (the local row was pruned) still yields a valid row — the
        // path and type are enough for the server to serve it.
        val write = MutationReplayPlan.plan(
            mutation(
                MutationKind.UPLOAD_PHOTO,
                """{"photo_id":"p1","inventory_item_id":"i1","storage_path":"u/i1/d_1.jpg"}""",
            ),
            owner,
            photoHints = null,
        ) as MutationReplayPlan.Write.Upsert
        assertEquals("detail", string(write, "photo_type"))
        assertNull(write.body["photo_url"])
        assertEquals(0, (write.body["sort_order"] as? JsonPrimitive)?.intOrNull)
    }

    // ── Expenses (US-1364) ───────────────────────────────────────────────────

    @Test
    fun expenseCreateTargetsTheServerTableName() {
        // The server table is `flipdesk_expenses`; Room's is `expenses`. Getting
        // this backwards is a silent 404 on every queued expense.
        val write = MutationReplayPlan.plan(
            mutation(
                MutationKind.CREATE_EXPENSE,
                """{"id":"e1","category":"supplies","amount":12.5,"spent_on":"2026-04-05"}""",
            ),
            owner,
        ) as MutationReplayPlan.Write.Upsert
        assertEquals("flipdesk_expenses", write.table)
        assertEquals(owner, string(write, "user_id"))
    }

    @Test
    fun expenseDeleteIsTenantScoped() {
        val write = MutationReplayPlan.plan(
            mutation(MutationKind.DELETE_EXPENSE, """{"id":"e1"}"""),
            owner,
        ) as MutationReplayPlan.Write.Delete
        assertEquals("flipdesk_expenses", write.table)
        assertEquals("e1", write.id)
        assertEquals(owner, write.userId)
    }

    // ── Terminal cases ───────────────────────────────────────────────────────

    @Test
    fun anUnparseablePayloadIsTerminal() {
        val error = runCatching {
            MutationReplayPlan.plan(
                mutation(MutationKind.CREATE_INVENTORY_ITEM, "not json at all"),
                owner,
            )
        }.exceptionOrNull()
        assertTrue(error is EdgeApiError.BadRequest)
        assertTrue(OfflineMutationQueue.isTerminal(error!!))
    }

    @Test
    fun anUnsupportedKindIsTerminalNotRetriedForever() {
        // CREATE_SALE has no Android enqueue site. Retrying it six times would
        // never make this build able to perform it.
        val error = runCatching {
            MutationReplayPlan.plan(mutation(MutationKind.CREATE_SALE, """{"id":"s1"}"""), owner)
        }.exceptionOrNull()
        assertTrue(error is EdgeApiError.BadRequest)
        assertTrue(OfflineMutationQueue.isTerminal(error!!))
    }

    @Test
    fun theTargetIdBacksTheIdWhenThePayloadOmitsIt() {
        val write = MutationReplayPlan.plan(
            mutation(MutationKind.DELETE_INVENTORY_ITEM, """{}""", targetId = "i9"),
            owner,
        ) as MutationReplayPlan.Write.Delete
        assertEquals("i9", write.id)
    }

    @Test
    fun rowIdResolvesTheLocalRowToReconcile() {
        assertEquals(
            "i1",
            MutationReplayPlan.rowIdOf(
                mutation(MutationKind.UPDATE_INVENTORY_ITEM, """{"id":"i1","patch":{}}"""),
            ),
        )
        assertEquals(
            "p1",
            MutationReplayPlan.rowIdOf(
                mutation(MutationKind.DELETE_PHOTO, """{"photo_id":"p1"}"""),
            ),
        )
        // A malformed payload falls back to targetId rather than throwing: this
        // runs AFTER a successful write, and failing here would re-run it.
        assertEquals(
            "t1",
            MutationReplayPlan.rowIdOf(
                mutation(MutationKind.UPDATE_INVENTORY_ITEM, "broken", targetId = "t1"),
            ),
        )
    }
}
