package com.gradethread.app.marketplaces

import com.gradethread.app.sync.db.ListingEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

/** US-1351: the unified listing card's display rules. */
class ListingCardModelTest {

    private fun listing(
        platform: String = "ebay",
        price: Double = 48.0,
        quantity: Int? = 1,
        status: String = "active",
        origin: String? = null,
        offerId: String? = null,
        url: String? = "https://www.ebay.com/itm/1",
        publishError: String? = null,
    ) = ListingEntity(
        id = "l1",
        inventoryItemId = "i1",
        platform = platform,
        platformListingId = "1",
        platformOfferId = offerId,
        externalUrl = url,
        listingPrice = price,
        listingStatus = status,
        listedAt = null,
        endedAt = null,
        viewsTotal = null,
        watchersCount = null,
        quantity = quantity,
        listingOrigin = origin,
        publishError = publishError,
        createdAt = 0L,
        updatedAt = 0L,
    )

    @Test
    fun `quantity has three states, not two`() {
        assertEquals("Qty 3", ListingCardModel.quantityText(3))
        // Published but unbuyable — the case a seller most needs told about.
        assertEquals("Out of stock", ListingCardModel.quantityText(0))
        // Never observed. Neither "Qty 1" (an invention) nor "Out of stock" (a lie).
        assertEquals("Qty —", ListingCardModel.quantityText(null))
    }

    @Test
    fun `platforms use their own capitalisation`() {
        assertEquals("eBay", ListingCardModel.platformLabel("ebay"))
        assertEquals("OfferUp", ListingCardModel.platformLabel("offerup"))
        // An unknown platform title-cases rather than showing a raw slug.
        assertEquals("Kixify", ListingCardModel.platformLabel("kixify"))
    }

    @Test
    fun `price is formatted as money, not a bare number`() {
        val model = ListingCardModel.from(listing(price = 48.5), Locale.US)
        assertEquals("$48.50", model.priceText)
    }

    @Test
    fun `an ebay-originated listing reads as imported`() {
        assertTrue(ListingCardModel.from(listing(origin = "ebay")).isImported)
    }

    @Test
    fun `a gradethread-originated listing is not imported even with no offer id`() {
        assertFalse(ListingCardModel.from(listing(origin = "gradethread", offerId = null)).isImported)
    }

    @Test
    fun `a legacy row falls back to the offer-id heuristic`() {
        // Only listings GradeThread published get a Sell API offer, so on a row
        // synced before the origin column existed, no offer means eBay's.
        assertTrue(ListingCardModel.from(listing(origin = null, offerId = null)).isImported)
        assertFalse(ListingCardModel.from(listing(origin = null, offerId = "o1")).isImported)
        // The heuristic is eBay-specific; a Poshmark row isn't "imported".
        assertFalse(ListingCardModel.from(listing(platform = "poshmark", origin = null)).isImported)
    }

    @Test
    fun `blank server strings are treated as absent`() {
        val model = ListingCardModel.from(listing(url = "", publishError = "  "))
        assertEquals(null, model.externalUrl)
        assertEquals(null, model.publishError)
    }

    @Test
    fun `the card reads as one sentence for TalkBack`() {
        val model = ListingCardModel.from(listing(quantity = 0, status = "active"), Locale.US)
        assertEquals("eBay listing, $48.00, Out of stock, Active", model.contentDescription)
    }
}
