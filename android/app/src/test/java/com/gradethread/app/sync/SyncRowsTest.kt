package com.gradethread.app.sync

import com.gradethread.app.money.SalePnL
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-2151: the pull row decoders.
 *
 * Every decoder is LENIENT — a malformed row yields null and is dropped,
 * which clamps the cursor before it so the row is retried rather than
 * stranded. A decoder that threw would fail the whole page instead.
 */
class SyncRowsTest {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }
    private fun obj(raw: String) = json.parseToJsonElement(raw) as JsonObject

    // ── sources ──────────────────────────────────────────────────────────

    @Test
    fun sourceDecodes() {
        val row = SyncRows.decodeSourceRow(
            obj(
                """{"id":"AB-1","user_id":"u1","name":"Goodwill","source_type":"thrift",
                "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-02T00:00:00Z"}""",
            ),
        )!!
        // Ids are lowercased so they match locally-generated ones.
        assertEquals("ab-1", row.id)
        assertEquals("Goodwill", row.name)
        assertNull(row.archivedAt)
    }

    @Test
    fun aNullArchivedAtMeansActiveNotMissing() {
        val active = SyncRows.decodeSourceRow(
            obj("""{"id":"a","user_id":"u","name":"X","archived_at":null}"""),
        )!!
        assertNull(active.archivedAt)
        val archived = SyncRows.decodeSourceRow(
            obj("""{"id":"a","user_id":"u","name":"X","archived_at":"2026-02-01T00:00:00Z"}"""),
        )!!
        assertTrue((archived.archivedAt ?: 0L) > 0L)
    }

    // ── listings ─────────────────────────────────────────────────────────

    @Test
    fun listingDecodesAndMapsServerColumnNames() {
        val row = SyncRows.decodeListingRow(
            obj(
                """{"id":"L1","inventory_item_id":"I1","platform":"ebay",
                "listing_url":"https://x","listing_price":42.5,"listing_status":"active",
                "views":10,"watchers":3}""",
            ),
        )!!
        // listing_url -> externalUrl, views -> viewsTotal: the local names differ.
        assertEquals("https://x", row.externalUrl)
        assertEquals(10, row.viewsTotal)
        assertEquals(3, row.watchersCount)
        assertEquals(42.5, row.listingPrice, 1e-9)
        assertEquals("i1", row.inventoryItemId)
    }

    @Test
    fun listingOriginIsReadNotGuessed() {
        // Provenance decides which side owns price and quantity, so it is read
        // straight from the server column — never inferred, never invented.
        val absent = SyncRows.decodeListingRow(
            obj("""{"id":"L1","inventory_item_id":"I1","platform":"ebay"}"""),
        )!!
        assertNull(absent.listingOrigin)

        val present = SyncRows.decodeListingRow(
            obj(
                """{"id":"L1","inventory_item_id":"I1","platform":"ebay",
                "listing_origin":"ebay"}""",
            ),
        )!!
        assertEquals("ebay", present.listingOrigin)
    }

    @Test
    fun listingDecodesTheEbayOwnedColumns() {
        // US-1351: these four were dropped by the decoder, so every pulled
        // listing looked eBay-native, quantity-less and error-free.
        val row = SyncRows.decodeListingRow(
            obj(
                """{"id":"L1","inventory_item_id":"I1","platform":"ebay",
                "platform_offer_id":"OF1","quantity":0,"listing_origin":"gradethread",
                "publish_error":"eBay rejected the revise"}""",
            ),
        )!!
        assertEquals("OF1", row.platformOfferId)
        // 0 is out of stock, a real value — it must not decode as null.
        assertEquals(0, row.quantity)
        assertEquals("gradethread", row.listingOrigin)
        assertEquals("eBay rejected the revise", row.publishError)
    }

    @Test
    fun listingFallsBackRatherThanFailingOnMissingOptionals() {
        val row = SyncRows.decodeListingRow(
            obj("""{"id":"L1","inventory_item_id":"I1"}"""),
        )!!
        assertEquals("other", row.platform)
        assertEquals("draft", row.listingStatus)
        assertEquals(0.0, row.listingPrice, 1e-9)
    }

    // ── sales ────────────────────────────────────────────────────────────

    @Test
    fun saleDecodesTheFlipdeskCostColumns() {
        val row = SyncRows.decodeSaleRow(
            obj(
                """{"id":"S1","inventory_item_id":"I1","sale_price":100.0,
                "platform_fees":13.0,"payment_processing_fees":3.2,"shipping_collected":8.0,
                "shipping_cost":6.5,"grading_cost":2.0,"other_costs":1.0,"net_profit":74.3,
                "sale_date":"2026-03-01T00:00:00Z"}""",
            ),
        )!!
        assertEquals(100.0, row.salePrice, 1e-9)
        assertEquals(3.2, row.paymentProcessingFees!!, 1e-9)
        assertEquals(74.3, row.netProfit!!, 1e-9)
    }

    @Test
    fun netProfitIsTakenFromTheServerNotRecomputed() {
        // net_profit deliberately EXCLUDES cost basis (which lives on
        // inventory_items.acquired_price), so deriving it from sale fields
        // alone would silently overstate profit on every item.
        val row = SyncRows.decodeSaleRow(
            obj("""{"id":"S1","inventory_item_id":"I1","sale_price":100.0,"platform_fees":10.0}"""),
        )!!
        assertNull(row.netProfit)
    }

    @Test
    fun saleStatusIsCarriedFromTheServer() {
        // REGRESSION: `status` was missing from the decoder, so every pulled
        // sale took SaleEntity's `completed` default. A refunded order then
        // counted as revenue and profit in the Money/Home/Analytics rollups —
        // exactly what migration 00111 says all metrics MUST exclude.
        val refunded = SyncRows.decodeSaleRow(
            obj("""{"id":"S1","inventory_item_id":"I1","sale_price":100.0,"status":"refunded"}"""),
        )!!
        assertEquals("refunded", refunded.status)

        val cancelled = SyncRows.decodeSaleRow(
            obj("""{"id":"S2","inventory_item_id":"I1","status":"cancelled"}"""),
        )!!
        assertEquals("cancelled", cancelled.status)
        assertFalse(SalePnL.isCompleted(cancelled))
    }

    @Test
    fun aLegacySaleWithNoStatusReadsAsCompleted() {
        // Rows predating 00111 carry no status; treating them as anything but
        // completed would erase historical revenue.
        val legacy = SyncRows.decodeSaleRow(
            obj("""{"id":"S1","inventory_item_id":"I1","sale_price":10.0}"""),
        )!!
        assertEquals("completed", legacy.status)
        assertTrue(SalePnL.isCompleted(legacy))

        val blank = SyncRows.decodeSaleRow(
            obj("""{"id":"S2","inventory_item_id":"I1","status":""}"""),
        )!!
        assertEquals("completed", blank.status)
    }

    @Test
    fun saleWithoutADateDecodesRatherThanDropping() {
        val row = SyncRows.decodeSaleRow(
            obj("""{"id":"S1","inventory_item_id":"I1","sale_price":5.0}"""),
        )!!
        assertEquals(0L, row.saleDate)
    }

    // ── expenses ─────────────────────────────────────────────────────────

    @Test
    fun expenseDecodesADateOnlySpentOn() {
        // spent_on is a DATE, not a timestamptz — the LocalDate parse branch
        // is what handles it, and without that every expense would land at 0.
        val row = SyncRows.decodeExpenseRow(
            obj("""{"id":"E1","category":"supplies","amount":12.5,"spent_on":"2026-04-05"}"""),
        )!!
        assertTrue(row.spentOn > 0L)
        assertEquals(12.5, row.amount, 1e-9)
        assertEquals("supplies", row.category)
    }

    @Test
    fun expenseDescriptionMapsFromTheServerColumn() {
        val row = SyncRows.decodeExpenseRow(
            obj("""{"id":"E1","description":"Poly mailers","amount":9.0}"""),
        )!!
        assertEquals("Poly mailers", row.expenseDescription)
    }

    // ── leniency ─────────────────────────────────────────────────────────

    @Test
    fun aRowMissingItsPrimaryKeyIsDroppedNotThrown() {
        // Dropping clamps the cursor before it, so the row is retried. A throw
        // would fail the entire page.
        assertNull(SyncRows.decodeSourceRow(obj("""{"user_id":"u","name":"X"}""")))
        assertNull(SyncRows.decodeListingRow(obj("""{"inventory_item_id":"I1"}""")))
        assertNull(SyncRows.decodeSaleRow(obj("""{"inventory_item_id":"I1"}""")))
        assertNull(SyncRows.decodeExpenseRow(obj("""{"amount":1.0}""")))
    }

    @Test
    fun aRowWithAWrongTypedFieldIsDropped() {
        assertNull(
            SyncRows.decodeSaleRow(
                obj("""{"id":"S1","inventory_item_id":"I1","sale_price":"not-a-number"}"""),
            ),
        )
    }

    @Test
    fun unknownServerColumnsAreIgnored() {
        // The server ships new columns ahead of the client routinely; that
        // must not start dropping every row.
        val row = SyncRows.decodeSourceRow(
            obj("""{"id":"a","user_id":"u","name":"X","some_new_column":{"nested":1}}"""),
        )
        assertEquals("a", row?.id)
    }

    @Test
    fun aPhotoWithNoUrlIsDropped() {
        // It can't render, and storing it would show a broken tile.
        assertNull(
            SyncRows.decodePhotoRow(
                obj("""{"id":"P1","inventory_item_id":"I1","photo_url":""}"""),
            ),
        )
    }

    @Test
    fun photoDecodesWithItsSortOrder() {
        val row = SyncRows.decodePhotoRow(
            obj(
                """{"id":"P1","inventory_item_id":"I1","photo_url":"https://x.jpg",
                "photo_type":"front","sort_order":2}""",
            ),
        )!!
        assertEquals("front", row.photoType)
        assertEquals(2, row.sortOrder)
        assertEquals("i1", row.inventoryItemId)
    }
}
