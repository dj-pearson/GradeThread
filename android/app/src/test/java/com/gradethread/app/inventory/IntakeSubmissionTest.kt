package com.gradethread.app.inventory

import com.gradethread.app.capture.DetailsIntakeState
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/**
 * US-1330: insert payload shape, the duplicate-SKU pre-check, the
 * never-send-null merge patch, and offline queueing.
 */
class IntakeSubmissionTest {

    private val filled = DetailsIntakeState(
        title = "  Vintage Tee  ",
        sku = "A1",
        brand = "Nike",
        size = "L",
        category = "clothing",
        status = "cataloged",
        container = "Bin 4",
        sourcedBy = "Dana",
        purchaseDate = "2026-01-02",
        purchasePriceText = "12.50",
        notes = "small stain",
    )

    private fun JsonObject.str(key: String) = this[key]?.jsonPrimitive?.content

    // ── Insert payload ──

    @Test
    fun insertPayload_trimsLowercasesTheId_andMapsColumnsCorrectly() {
        val p = IntakeSubmission.insertPayload(filled, "owner-1", "ITEM-ABC")

        assertEquals("item-abc", p.str("id")) // the uppercase-uuid sync bug
        assertEquals("owner-1", p.str("user_id"))
        assertEquals("Vintage Tee", p.str("title"))
        assertEquals("12.50", p.str("acquired_price"))
        assertEquals("2026-01-02", p.str("acquired_date"))
        // Notes → description, price → acquired_price. Not condition_notes,
        // not target_price.
        assertEquals("small stain", p.str("description"))
        assertNull(p["condition_notes"])
        assertNull(p["target_price"])
    }

    @Test
    fun insertPayload_omitsBlanks_soPostgresGetsNullNotEmptyString() {
        val sparse = DetailsIntakeState(title = "Tee")
        val p = IntakeSubmission.insertPayload(sparse, "owner-1", "item-1")

        // A "" SKU would occupy the partial unique index and collide with the
        // next blank-SKU item.
        assertFalse(p.containsKey("sku"))
        assertFalse(p.containsKey("brand"))
        assertFalse(p.containsKey("acquired_price"))
        assertFalse(p.containsKey("acquired_date"))
        assertFalse(p.containsKey("description"))
        // Always present.
        assertEquals("Tee", p.str("title"))
        assertEquals("clothing", p.str("item_category"))
        assertEquals("cataloged", p.str("status"))
    }

    // ── Duplicate-SKU pre-check ──

    @Test
    fun anExistingSku_returnsMergeRequired_withoutInserting() = runTest {
        var inserted = false
        val existing = IntakeSubmission.ExistingItem(id = "other-1", title = "Old Tee", size = "M")

        val outcome = IntakeSubmission.submit(
            filled, "owner-1", "item-1",
            findBySku = { existing },
            insert = { inserted = true },
            shouldQueue = { false },
            enqueue = { _, _ -> },
        )

        assertTrue(outcome is IntakeSubmission.Outcome.MergeRequired)
        // Never hit the unique index — the whole point of the pre-check.
        assertFalse(inserted)
        assertEquals(existing, (outcome as IntakeSubmission.Outcome.MergeRequired).existing)
    }

    @Test
    fun aBlankSku_skipsTheLookupEntirely() = runTest {
        var lookups = 0
        IntakeSubmission.submit(
            filled.copy(sku = "   "), "owner-1", "item-1",
            findBySku = { lookups++; null },
            insert = {},
            shouldQueue = { false },
            enqueue = { _, _ -> },
        )
        assertEquals(0, lookups)
    }

    @Test
    fun aFailedLookup_degradesToANormalInsert() = runTest {
        var inserted = false
        val outcome = IntakeSubmission.submit(
            filled, "owner-1", "item-1",
            findBySku = { throw IOException("offline") },
            insert = { inserted = true },
            shouldQueue = { false },
            enqueue = { _, _ -> },
        )
        // A flaky read must not block cataloging; the index still protects us.
        assertTrue(inserted)
        assertTrue(outcome is IntakeSubmission.Outcome.Inserted)
    }

    // ── Offline ──

    @Test
    fun offlineInsert_queuesWithTheSameLowercasedId_soReplayUpserts() = runTest {
        var queuedId: String? = null
        var queuedPayload: JsonObject? = null

        val outcome = IntakeSubmission.submit(
            filled, "owner-1", "ITEM-ABC",
            findBySku = { null },
            insert = { throw IOException("offline") },
            shouldQueue = { it is IOException },
            enqueue = { id, payload -> queuedId = id; queuedPayload = payload },
        )

        assertEquals(IntakeSubmission.Outcome.Queued("item-abc"), outcome)
        assertEquals("item-abc", queuedId)
        // The queued body carries the same id, so replay is an upsert.
        assertEquals("item-abc", queuedPayload?.str("id"))
    }

    @Test
    fun aNonNetworkFailure_isReportedNotQueued() = runTest {
        var queued = false
        val boom = IllegalStateException("bad request")

        val outcome = IntakeSubmission.submit(
            filled, "owner-1", "item-1",
            findBySku = { null },
            insert = { throw boom },
            // Typed classification — never English substring matching.
            shouldQueue = { it is IOException },
            enqueue = { _, _ -> queued = true },
        )

        assertFalse(queued)
        assertEquals(boom, (outcome as IntakeSubmission.Outcome.Failed).error)
    }

    // ── Merge patch ──

    @Test
    fun mergePatch_gapFillsBlanksButNeverSendsNull() {
        val existing = IntakeSubmission.ExistingItem(
            id = "other-1",
            title = "Old Tee",
            brand = null, // gap → filled from the form
            size = "L", // agrees → omitted
            status = "listed",
        )
        val patch = IntakeSubmission.mergePatch(filled, existing, keepExisting = emptySet())

        assertEquals("Nike", patch.str("brand")) // gap-filled
        assertEquals("Vintage Tee", patch.str("title")) // real conflict, form wins
        assertFalse(patch.containsKey("size")) // already agrees
        // A JSON null here would WIPE the column — the opposite of combine.
        for ((_, v) in patch) assertFalse(v.toString() == "null")
    }

    @Test
    fun mergePatch_neverTouchesStatusOrSku() {
        val existing = IntakeSubmission.ExistingItem(id = "o", status = "sold")
        val patch = IntakeSubmission.mergePatch(filled, existing, emptySet())
        // Re-cataloging must not regress a listed/sold item.
        assertFalse(patch.containsKey("status"))
        assertFalse(patch.containsKey("sku"))
    }

    @Test
    fun keepExisting_omitsThoseFieldsEntirely() {
        val existing = IntakeSubmission.ExistingItem(id = "o", brand = "Adidas", title = "Old")
        val patch = IntakeSubmission.mergePatch(
            filled, existing,
            keepExisting = setOf(ItemMergePlan.Field.BRAND),
        )
        assertFalse(patch.containsKey("brand")) // user kept "Adidas"
        assertEquals("Vintage Tee", patch.str("title")) // still overwritten
    }

    @Test
    fun mergePatch_treatsEquivalentPricesAsNoChange() {
        val existing = IntakeSubmission.ExistingItem(id = "o", acquiredPrice = "12.5")
        val patch = IntakeSubmission.mergePatch(
            filled.copy(purchasePriceText = "12.50"), existing, emptySet(),
        )
        // 12.5 and 12.50 are the same money.
        assertFalse(patch.containsKey("acquired_price"))

        val changed = IntakeSubmission.mergePatch(
            filled.copy(purchasePriceText = "20"), existing, emptySet(),
        )
        assertEquals("20.00", changed.str("acquired_price"))
    }

    @Test
    fun conflicts_excludeStatus() {
        val existing = IntakeSubmission.ExistingItem(id = "o", status = "sold", brand = "Adidas")
        val conflicts = IntakeSubmission.conflictsFor(filled, existing)
        assertFalse(conflicts.any { it.field == ItemMergePlan.Field.STATUS })
        assertTrue(conflicts.any { it.field == ItemMergePlan.Field.BRAND })
    }
}
