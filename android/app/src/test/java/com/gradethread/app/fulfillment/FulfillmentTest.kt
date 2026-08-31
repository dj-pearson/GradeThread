package com.gradethread.app.fulfillment

import com.gradethread.app.money.MoneyFixtures
import com.gradethread.app.sync.MutationKind
import com.gradethread.app.sync.db.SaleEntity
import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1377: the shipping queue. Ordering and the eBay-versus-local decision are
 * what matter — a parcel that falls out of the queue is a parcel nobody posts.
 */
class FulfillmentTest {

    private val now = MoneyFixtures.ms(2026, 7, 10)
    private val day = 86_400_000L
    private fun daysAgo(days: Int) = now - days * day

    private fun sale(
        id: String,
        itemId: String = "i-$id",
        soldAt: Long? = null,
        saleDate: Long = daysAgo(1),
        shippedAt: Long? = null,
        status: String = "completed",
        platformOrderId: String? = "order-$id",
        tracking: String? = null,
        shippingCost: Double? = null,
    ): SaleEntity = MoneyFixtures.sale(
        id = id,
        itemId = itemId,
        status = status,
        saleDate = saleDate,
        shippingCost = shippingCost,
    ).copy(
        soldAt = soldAt,
        shippedAt = shippedAt,
        platformOrderId = platformOrderId,
        trackingNumber = tracking,
    )

    private fun order(sale: SaleEntity, title: String? = "A jacket") = FulfillmentOrder(sale, title)

    // ── The queue ────────────────────────────────────────────────────────────

    @Test
    fun `only unshipped sales are in the queue, oldest first`() {
        // Oldest first is the point: this is a to-do list ranked by how overdue
        // each parcel is, not a feed of recent news.
        val sales = listOf(
            sale("new", saleDate = daysAgo(1)),
            sale("old", saleDate = daysAgo(9)),
            sale("done", saleDate = daysAgo(20), shippedAt = daysAgo(19)),
        )

        val queue = Fulfillment.queue(sales, emptyList())
        assertEquals(listOf("old", "new"), queue.map { it.id })
    }

    @Test
    fun `soldAt beats saleDate for the ship-by ranking`() {
        // eBay's own sold timestamp is the one the handling clock runs from.
        val sales = listOf(
            sale("a", saleDate = daysAgo(1), soldAt = daysAgo(8)),
            sale("b", saleDate = daysAgo(5)),
        )
        assertEquals(listOf("a", "b"), Fulfillment.queue(sales, emptyList()).map { it.id })
    }

    @Test
    fun `cancelled and refunded orders never appear`() {
        // Nothing is going in the post for those, and listing one sends a
        // seller hunting for a parcel that shouldn't exist.
        val sales = listOf(
            sale("ok"),
            sale("cancelled", status = "cancelled"),
            sale("refunded", status = "refunded"),
        )
        assertEquals(listOf("ok"), Fulfillment.queue(sales, emptyList()).map { it.id })
    }

    @Test
    fun `pending orders are included`() {
        // Money not yet settled still means a parcel to post.
        assertEquals(1, Fulfillment.queue(listOf(sale("p", status = "pending")), emptyList()).size)
    }

    @Test
    fun `a sale with a blank status is not dropped`() {
        // Rows predating the status column carry none; excluding them would
        // hide real orders.
        assertEquals(1, Fulfillment.queue(listOf(sale("legacy", status = "")), emptyList()).size)
    }

    @Test
    fun `a manual sale with no eBay order is still in the queue`() {
        // The post-sale surface only lists eBay orders because feedback and
        // tracking both need an order id. A manually recorded sale still needs
        // posting, and leaving it out is how a parcel gets forgotten.
        val queue = Fulfillment.queue(listOf(sale("manual", platformOrderId = null)), emptyList())
        assertEquals(1, queue.size)
        assertFalse(queue.single().onEbay)
    }

    @Test
    fun `the item title comes from the inventory row`() {
        val queue = Fulfillment.queue(
            listOf(sale("s", itemId = "i1")),
            listOf(MoneyFixtures.item("i1", title = "Patagonia fleece")),
        )
        assertEquals("Patagonia fleece", queue.single().displayTitle)
    }

    @Test
    fun `a titleless sale falls back rather than showing nothing`() {
        val withBuyer = order(sale("s"), title = null)
            .copy(sale = sale("s").copy(buyerUsername = "adabuys"))
        assertEquals("Sale to adabuys", withBuyer.displayTitle)
        assertTrue(order(sale("abcdefghij"), title = null).displayTitle.startsWith("Sale "))
    }

    // ── Overdue ──────────────────────────────────────────────────────────────

    @Test
    fun `nothing is overdue on the day it sells`() {
        // Flagging every order the day it sells makes the warning meaningless.
        assertFalse(Fulfillment.overdue(order(sale("s", saleDate = now)), now))
        assertFalse(Fulfillment.overdue(order(sale("s", saleDate = daysAgo(2))), now))
        assertTrue(Fulfillment.overdue(order(sale("s", saleDate = daysAgo(3))), now))
    }

    @Test
    fun `a future timestamp reads as brand new, not as negative days`() {
        assertEquals(0, Fulfillment.daysWaiting(order(sale("s", saleDate = now + 5 * day)), now))
    }

    @Test
    fun `the waiting label reads naturally`() {
        // Today and yesterday are their OWN resources, not "Waiting 0 days" -
        // which is the whole reason this reads naturally.
        assertEquals(
            R.string.fulfillment_sold_today,
            Fulfillment.waitingLabel(order(sale("s", saleDate = now)), now).res,
        )
        assertEquals(
            R.string.fulfillment_sold_yesterday,
            Fulfillment.waitingLabel(order(sale("s", saleDate = daysAgo(1))), now).res,
        )

        val waiting = Fulfillment.waitingLabel(order(sale("s", saleDate = daysAgo(6))), now)
        assertEquals(R.plurals.fulfillment_waiting_days, waiting.res)
        assertEquals(6, waiting.quantity)
    }

    // ── Where the write goes ─────────────────────────────────────────────────

    @Test
    fun `an eBay order with tracking goes to eBay`() {
        assertTrue(Fulfillment.goesToEbay(order(sale("s")), "1Z999"))
    }

    @Test
    fun `an eBay order with no tracking is written locally instead`() {
        // eBay's fulfilment API requires a tracking number. Sending it anyway
        // fails in a way the seller can do nothing about.
        assertFalse(Fulfillment.goesToEbay(order(sale("s")), null))
        assertFalse(Fulfillment.goesToEbay(order(sale("s")), ""))
    }

    @Test
    fun `a non-eBay sale never goes to eBay even with tracking`() {
        assertFalse(
            Fulfillment.goesToEbay(order(sale("s", platformOrderId = null)), "1Z999"),
        )
    }

    @Test
    fun `tracking numbers survive being pasted off a label`() {
        // Carriers' apps and printed labels wrap them; failing only because of
        // a line break is a bad afternoon.
        assertEquals("1Z999AA10123456784", Fulfillment.trackingNumber(" 1Z999AA1 0123456784 \n"))
        assertNull(Fulfillment.trackingNumber("   "))
        assertNull(Fulfillment.trackingNumber(""))
    }

    // ── Summaries ────────────────────────────────────────────────────────────

    @Test
    fun `the summary names how many are late`() {
        assertEquals(
            R.string.fulfillment_nothing_waiting,
            Fulfillment.summary(emptyList(), now).res,
        )

        // Nothing late: the plural stands alone, with no empty clause after it.
        val one = Fulfillment.queue(listOf(sale("a", saleDate = daysAgo(1))), emptyList())
        val onlyOne = Fulfillment.summary(one, now)
        assertEquals(R.plurals.fulfillment_parcels, onlyOne.res)
        assertEquals(1, onlyOne.quantity)

        val mixed = Fulfillment.queue(
            listOf(sale("a", saleDate = daysAgo(1)), sale("b", saleDate = daysAgo(9))),
            emptyList(),
        )
        // US-2976: the count line NESTS inside the overdue line. The window is
        // an argument too, so a change to SHIP_BY_DAYS cannot leave the
        // sentence quoting the old number.
        val late = Fulfillment.summary(mixed, now)
        assertEquals(R.string.fulfillment_summary_late, late.res)
        assertEquals(
            listOf<Any>(
                UiMessage(R.plurals.fulfillment_parcels, args = listOf(2), quantity = 2),
                1,
                Fulfillment.SHIP_BY_DAYS,
            ),
            late.args,
        )
    }

    @Test
    fun `label cost sums through Money`() {
        val queue = Fulfillment.queue(
            listOf(
                sale("a", shippingCost = 4.99),
                sale("b", shippingCost = 6.25),
                sale("c"),
            ),
            emptyList(),
        )
        assertEquals(11.24, Fulfillment.totalLabelCost(queue), 0.0001)
    }

    @Test
    fun `a queued mark-shipped says it hasn't reached eBay yet`() {
        // Saying "done" would have someone stop chasing a notification that
        // never went out.
        // US-2976: three DIFFERENT resources, which is what the distinction
        // was always made of. A queued mark and a sent one sharing a resource
        // is exactly the failure this test guards against.
        val queued = Fulfillment.confirmation(order(sale("s")), "1Z999", queued = true)
        assertEquals(R.string.fulfillment_queued_unnamed, queued.res)

        val sent = Fulfillment.confirmation(order(sale("s")), "1Z999", queued = false)
        assertEquals(R.string.fulfillment_shipped_unnamed_tracking, sent.res)
        // The tracking number reaches the sentence, because a confirmation that
        // omits it cannot be checked against the carrier.
        assertEquals(listOf<Any>("1Z999"), sent.args)

        val noTracking = Fulfillment.confirmation(order(sale("s")), null, queued = false)
        assertEquals(R.string.fulfillment_shipped_unnamed, noTracking.res)
    }

    // ── The offline payload ──────────────────────────────────────────────────

    @Test
    fun `the queued payload carries tracking only when there is some`() {
        // A replay that wrote an empty tracking_number would null out one the
        // server already has.
        val withTracking = String(
            FulfillmentService.payload("s1", "2026-07-10T09:00:00Z", "1Z999"),
        )
        assertTrue(withTracking.contains("\"tracking_number\":\"1Z999\""))
        assertTrue(withTracking.contains("\"id\":\"s1\""))
        assertTrue(withTracking.contains("\"patch\""))

        val without = String(FulfillmentService.payload("s1", "2026-07-10T09:00:00Z", null))
        assertFalse(without.contains("tracking_number"))
        assertTrue(without.contains("shipped_at"))
    }

    @Test
    fun `the mutation kind has a stable wire name`() {
        // The queue stores this string on disk; renaming it would strand every
        // pending mark-shipped on an upgrade.
        assertEquals("markShipped", MutationKind.MARK_SHIPPED.wire)
    }

    // ── Shipped list ─────────────────────────────────────────────────────────

    @Test
    fun `recently posted shows newest first and is capped`() {
        val sales = (1..25).map {
            sale("s$it", saleDate = daysAgo(it), shippedAt = daysAgo(it))
        }
        val shipped = Fulfillment.shipped(sales, emptyList())
        assertEquals(20, shipped.size)
        assertEquals("s1", shipped.first().id)
    }
}
