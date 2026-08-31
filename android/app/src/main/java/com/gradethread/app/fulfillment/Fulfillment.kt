package com.gradethread.app.fulfillment

import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage

import com.gradethread.app.money.Money
import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.sync.db.SaleEntity

/**
 * US-1377 (iOS `FulfillmentStore`, US-669): what still has to go in the post.
 *
 * Fed from the SYNCED `sales` rows, so the queue works with no signal — which
 * matters more here than on most screens, because the place people pack parcels
 * is usually the place with the worst reception in the building.
 *
 * Broader than the post-sale surface (US-1357): that one only lists eBay orders,
 * because leaving feedback and telling eBay about tracking both need an eBay
 * order id. A manually recorded sale still needs posting, and leaving it out of
 * the shipping queue is how a parcel gets forgotten.
 */
data class FulfillmentOrder(val sale: SaleEntity, val itemTitle: String?) {
    val id: String get() = sale.id

    val displayTitle: String
        get() = itemTitle?.takeIf { it.isNotBlank() }
            ?: sale.buyerUsername?.takeIf { it.isNotBlank() }?.let { "Sale to $it" }
            ?: "Sale ${sale.id.take(8)}"

    /** `soldAt` when eBay reported it, else the recorded sale date. */
    val soldAtMs: Long get() = sale.soldAt ?: sale.saleDate

    val shipped: Boolean get() = sale.shippedAt != null

    /** True when the order can be told to eBay rather than only recorded here. */
    val onEbay: Boolean get() = !sale.platformOrderId.isNullOrBlank()

    val existingTracking: String? get() = sale.trackingNumber?.takeIf { it.isNotBlank() }
}

object Fulfillment {

    /** eBay's own handling-time expectation, and a fair default for anywhere else. */
    const val SHIP_BY_DAYS = 3

    private const val DAY_MS = 86_400_000L

    /**
     * Sold, not yet shipped, oldest first.
     *
     * Oldest first is the whole point of the ordering: the queue is a to-do
     * list ranked by how overdue each parcel is, not a feed of recent news.
     *
     * Cancelled and refunded orders are excluded — nothing is going in the post
     * for those, and listing one sends a seller hunting for a parcel that
     * shouldn't exist.
     */
    fun queue(sales: List<SaleEntity>, items: List<InventoryItemEntity>): List<FulfillmentOrder> {
        val titleById = items.associate { it.id to it.title }
        return sales
            .filter { it.shippedAt == null }
            .filter { it.status.isBlank() || it.status == "completed" || it.status == "pending" }
            .map { FulfillmentOrder(it, titleById[it.inventoryItemId]) }
            .sortedBy { it.soldAtMs }
    }

    /** Already shipped, most recent first — the "done" half of the surface. */
    fun shipped(sales: List<SaleEntity>, items: List<InventoryItemEntity>, limit: Int = 20): List<FulfillmentOrder> {
        val titleById = items.associate { it.id to it.title }
        return sales
            .filter { it.shippedAt != null }
            .sortedByDescending { it.shippedAt }
            .take(limit)
            .map { FulfillmentOrder(it, titleById[it.inventoryItemId]) }
    }

    /** Days since it sold. Zero on a future timestamp rather than a negative. */
    fun daysWaiting(order: FulfillmentOrder, nowMs: Long): Int = maxOf(0, ((nowMs - order.soldAtMs) / DAY_MS).toInt())

    /**
     * Past the handling window.
     *
     * Three days, not one: flagging every order the day it sells would make the
     * warning meaningless, and a seller who packs on Saturdays isn't late on
     * Friday.
     */
    fun overdue(order: FulfillmentOrder, nowMs: Long): Boolean = daysWaiting(order, nowMs) >= SHIP_BY_DAYS

    fun waitingLabel(order: FulfillmentOrder, nowMs: Long): UiMessage = when (val days = daysWaiting(order, nowMs)) {
        0 -> UiMessage(R.string.fulfillment_sold_today)
        1 -> UiMessage(R.string.fulfillment_sold_yesterday)
        else -> UiMessage(
            R.plurals.fulfillment_waiting_days,
            args = listOf(days),
            quantity = days,
        )
    }

    /**
     * A tracking number, or null.
     *
     * Whitespace is stripped throughout because carriers' apps and printed
     * labels wrap them, and a number that fails only because it was pasted with
     * a line break is a bad afternoon.
     */
    fun trackingNumber(text: String): String? = text.filterNot { it.isWhitespace() }.takeIf { it.isNotEmpty() }

    /**
     * Whether marking shipped should go to eBay rather than only to our own row.
     *
     * eBay's fulfilment API REQUIRES a tracking number, so an eBay order with
     * none falls through to the local write. Sending it anyway would fail in a
     * way the seller can do nothing about.
     */
    fun goesToEbay(order: FulfillmentOrder, tracking: String?): Boolean = order.onEbay && !tracking.isNullOrBlank()

    /** Total outstanding label cost across the queue. */
    fun totalLabelCost(orders: List<FulfillmentOrder>): Double = Money.sum(orders.map { it.sale.shippingCost ?: 0.0 })

    /** The line above the queue, so an empty one still says something. */
    fun summary(orders: List<FulfillmentOrder>, nowMs: Long): UiMessage {
        if (orders.isEmpty()) return UiMessage(R.string.fulfillment_nothing_waiting)
        val base = UiMessage(
            R.plurals.fulfillment_parcels,
            args = listOf(orders.size),
            quantity = orders.size,
        )
        val late = orders.count { overdue(it, nowMs) }
        if (late == 0) return base
        // US-2976: the count line NESTS inside the overdue line rather than
        // being concatenated onto it. "N parcels to post" is a plural in its
        // own right, and a language that words the two clauses in the other
        // order can now do so.
        return UiMessage(
            R.string.fulfillment_summary_late,
            args = listOf(base, late, SHIP_BY_DAYS),
        )
    }

    /** What to say after a successful mark-shipped. */
    /**
     * What to say after a successful mark-shipped.
     *
     * US-2976: SIX whole sentences rather than three with a "to <buyer>" /
     * "for this order" fragment glued in. The fragment is a prepositional
     * phrase, and where it sits in the sentence - and which preposition it
     * takes - is a fact about the language, not about the order. Spanish
     * already wants "Marcado como enviado a Ana", which the concatenation
     * could not produce.
     */
    fun confirmation(order: FulfillmentOrder, tracking: String?, queued: Boolean): UiMessage {
        val who = order.sale.buyerUsername?.takeIf { it.isNotBlank() }
        return when {
            // Named as queued, not as done: the parcel is marked here but eBay
            // and the buyer haven't been told yet, and pretending otherwise is
            // how someone stops chasing a notification that never went out.
            queued ->
                who
                    ?.let { UiMessage(R.string.fulfillment_queued_named, args = listOf(it)) }
                    ?: UiMessage(R.string.fulfillment_queued_unnamed)

            tracking == null ->
                who
                    ?.let { UiMessage(R.string.fulfillment_shipped_named, args = listOf(it)) }
                    ?: UiMessage(R.string.fulfillment_shipped_unnamed)

            else ->
                who
                    ?.let {
                        UiMessage(
                            R.string.fulfillment_shipped_named_tracking,
                            args = listOf(it, tracking),
                        )
                    }
                    ?: UiMessage(
                        R.string.fulfillment_shipped_unnamed_tracking,
                        args = listOf(tracking),
                    )
        }
    }
}
