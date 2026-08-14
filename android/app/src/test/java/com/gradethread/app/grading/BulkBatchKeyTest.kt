package com.gradethread.app.grading

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-2564: the charge token for a bulk grading submit.
 *
 * The edge dedupes its credit debit on `batch_key` + item id, so a token that is
 * fresh per attempt is worse than no feature at all — it looks like protection
 * while every retry still charges. These pin the three properties that make it
 * work: stable for a selection, different for a different selection, and short
 * enough to survive the request schema.
 */
class BulkBatchKeyTest {

    private val a = "11111111-1111-4111-8111-111111111111"
    private val b = "22222222-2222-4222-8222-222222222222"
    private val c = "33333333-3333-4333-8333-333333333333"

    private fun key(ids: List<String>, tier: String = "standard") = GradingRequestBody.bulkBatchKey(ids, tier)

    @Test
    fun `is stable for the same selection and tier`() {
        assertEquals(key(listOf(a, b)), key(listOf(a, b)))
    }

    @Test
    fun `ignores selection order`() {
        // A seller ticking items bottom-up must not be charged a second time for
        // the same batch.
        assertEquals(key(listOf(a, b, c)), key(listOf(c, a, b)))
    }

    @Test
    fun `changes when the selection changes`() {
        assertNotEquals(key(listOf(a, b)), key(listOf(a, c)))
        assertNotEquals(key(listOf(a)), key(listOf(a, b)))
    }

    @Test
    fun `changes when the tier changes`() {
        // Re-grading the same items at a higher tier is a real second charge and
        // must not be suppressed as a duplicate.
        assertNotEquals(key(listOf(a, b), "standard"), key(listOf(a, b), "premium"))
    }

    @Test
    fun `is null for an empty selection`() {
        // A token for "no items" would be shared by every empty batch.
        assertNull(key(emptyList()))
    }

    @Test
    fun `stays under the 255 character request cap at the batch limit`() {
        // The constraint that rules out the obvious implementation: joining 200
        // sorted UUIDs is ~7.4 KB, and the edge's strict schema caps batch_key at
        // 255 characters, so a full batch would fail all 200 items with a 400.
        val ids = (0 until GradingRequestBody.MAX_BATCH).map {
            "%08d-1111-4111-8111-111111111111".format(it)
        }
        val k = requireNotNull(key(ids))
        assertTrue("token was ${k.length} chars", k.length <= 255)
        assertTrue("token should be bounded, not merely short", k.length < 40)
    }

    @Test
    fun `does not collide across many distinct selections`() {
        // Two 32-bit passes plus the count. A collision would suppress a real
        // charge, i.e. silently drop a garment from a batch.
        val seen = HashSet<String>()
        for (i in 0 until 5000) {
            seen.add(requireNotNull(key(listOf("%08d-1111-4111-8111-111111111111".format(i), a))))
        }
        assertEquals(5000, seen.size)
    }

    @Test
    fun `the batch request body carries the token and the single one does not`() {
        val batch = GradingRequestBody.batch(listOf(a, b), GradeTier.STANDARD)
        assertEquals(key(listOf(a, b)), batch.batchKey)

        // Null, not "". An empty string is a real key that every keyless caller
        // would share, so the first such charge would suppress every later one.
        val single = GradingRequestBody.single(a, GradeTier.STANDARD)
        assertNull(single.batchKey)
    }

    @Test
    fun `the token describes the CAPPED list actually sent`() {
        // batch() truncates at MAX_BATCH. Deriving the token from the untruncated
        // selection would describe a batch the server never saw.
        val ids = (0 until GradingRequestBody.MAX_BATCH + 5).map {
            "%08d-1111-4111-8111-111111111111".format(it)
        }
        val body = GradingRequestBody.batch(ids, GradeTier.STANDARD)
        assertEquals(GradingRequestBody.MAX_BATCH, body.items.size)
        assertEquals(key(ids.take(GradingRequestBody.MAX_BATCH)), body.batchKey)
    }
}
