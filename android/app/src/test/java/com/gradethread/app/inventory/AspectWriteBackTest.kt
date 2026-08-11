package com.gradethread.app.inventory

import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.sync.MutationKind
import com.gradethread.app.sync.MutationReplayPlan
import com.gradethread.app.sync.OfflineMutationQueue
import com.gradethread.app.sync.db.PendingMutationEntity
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/**
 * US-2413: folding specifics-editor edits back into the item's own columns.
 *
 * Brand, Size, Color, Material and Style are single-entry and the COLUMN is the
 * write-authority at publish, so an aspect that never reached its column was
 * not just unsynced — the next ordinary save projected the empty column forward
 * and wiped it. These tests pin the two halves that decide whether that happens:
 * what goes on the wire, and what happens when the wire is not there.
 */
class AspectWriteBackTest {

    // ── the payload: every value, not just the first ─────────────────────

    @Test
    fun `a multi-value aspect sends all of its values`() {
        // The server decides per registry entry whether a field takes one value
        // or the whole list. A client that sent values[0] would silently turn a
        // three-value Features specific into a one-value one, and the loss
        // would only show up on the live listing.
        val body = AspectWriteBackService.payload(
            itemId = "item-1",
            aspects = mapOf("Features" to listOf("Pockets", "Lined", "Water Resistant")),
            sources = mapOf("Features" to AspectSync.Provenance.MANUAL),
        )
        val values = body.getValue("aspects").jsonObject.getValue("Features").jsonArray
        assertEquals(3, values.size)
        assertEquals(
            listOf("Pockets", "Lined", "Water Resistant"),
            values.map { it.jsonPrimitive.content },
        )
    }

    @Test
    fun `provenance rides along, because the server refuses to write back a derived value`() {
        // Without it the server would write a value the item's own column
        // derived straight back onto that column, in a loop.
        val body = AspectWriteBackService.payload(
            itemId = "item-1",
            aspects = mapOf("Brand" to listOf("Nike")),
            sources = mapOf("Brand" to AspectSync.Provenance.INVENTORY_DERIVED),
        )
        assertEquals(
            "inventory_derived",
            body.getValue("sources").jsonObject.getValue("Brand").jsonPrimitive.content,
        )
        assertEquals("item-1", body.getValue("itemId").jsonPrimitive.content)
    }

    @Test
    fun `blank values are dropped, and an aspect left with none is left out`() {
        val body = AspectWriteBackService.payload(
            itemId = "item-1",
            aspects = mapOf(
                "Brand" to listOf("  Nike  "),
                "Style" to listOf("  ", ""),
            ),
            sources = emptyMap(),
        )
        val aspects = body.getValue("aspects").jsonObject
        assertEquals("Nike", aspects.getValue("Brand").jsonArray.single().jsonPrimitive.content)
        assertFalse(aspects.containsKey("Style"))
    }

    // ── the replay: a failed write-back is not dropped ───────────────────

    private fun queued(payloadJson: String) = PendingMutationEntity(
        id = "m1",
        kind = MutationKind.EBAY_ASPECT_WRITE_BACK.wire,
        payload = payloadJson.toByteArray(),
        targetId = "item-1",
        lastError = null,
        lastAttemptAt = null,
        createdAt = 0,
    )

    @Test
    fun `a queued write-back replays as the same POST, verbatim`() {
        val body = AspectWriteBackService.payload(
            itemId = "item-1",
            aspects = mapOf("Features" to listOf("Pockets", "Lined")),
            sources = mapOf("Features" to AspectSync.Provenance.MANUAL),
        )
        val plan = MutationReplayPlan.plan(queued(body.toString()), owner = "u1")

        assertTrue("was $plan", plan is MutationReplayPlan.Write.EdgePost)
        val post = plan as MutationReplayPlan.Write.EdgePost
        assertEquals(AspectWriteBackService.PATH, post.path)
        // Replayed as the same bytes rather than rebuilt: there is nothing to
        // get wrong a second time, and the multi-value list survives intact.
        assertEquals(body, post.body)
        assertEquals(
            2,
            post.body.getValue("aspects").jsonObject.getValue("Features").jsonArray.size,
        )
    }

    @Test
    fun `the replay path matches the one the live call uses`() {
        // Two constants, one endpoint. If they drift, every queued write-back
        // replays into a 404 and the specifics quietly stop syncing.
        assertEquals(AspectWriteBackService.PATH, MutationReplayPlan.ASPECT_WRITE_BACK_PATH)
    }

    @Test
    fun `a connection failure is queued, a server refusal is not`() {
        // The queue is for calls that would succeed later. A 4xx will refuse
        // identically on every retry, so queueing it fills the inspector with
        // work nobody can clear.
        assertTrue(OfflineMutationQueue.shouldEnqueue(IOException("no route to host")))
        assertTrue(OfflineMutationQueue.shouldEnqueue(EdgeApiError.Network("offline")))
        assertTrue(OfflineMutationQueue.shouldEnqueue(EdgeApiError.ServerError("boom")))
        assertFalse(OfflineMutationQueue.shouldEnqueue(EdgeApiError.NotFound("Item not found.")))
        assertFalse(OfflineMutationQueue.shouldEnqueue(EdgeApiError.BadRequest("itemId is required")))
    }

    @Test
    fun `a queued write-back is retryable, not terminal`() {
        // Terminal would send it straight to the inspector; the whole point is
        // that it lands once the phone has signal again.
        assertFalse(OfflineMutationQueue.isTerminal(EdgeApiError.Network("offline")))
        assertFalse(OfflineMutationQueue.isTerminal(EdgeApiError.ServerError("boom")))
    }
}
