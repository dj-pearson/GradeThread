package com.gradethread.app.consignment

import com.gradethread.app.money.Money
import com.gradethread.app.money.SalePnL
import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.sync.db.SaleEntity

/** One consignor's payout summary over the reported sales. */
data class ConsignmentReportRow(
    val consignorId: String,
    val consignorName: String,
    val itemsSold: Int,
    val grossRevenue: Double,
    val fees: Double,
    /** Gross minus fees. */
    val netProceeds: Double,
    /** What the consignor is owed. */
    val consignorPayout: Double,
    /** What the reseller keeps. */
    val yourCut: Double,
)

/**
 * US-1372 (iOS `ConsignmentReport`): who is owed what.
 *
 * Net proceeds are sale price minus fees; the consignor gets their split of
 * that (per-item override first, then the consignor's default); the reseller
 * keeps the rest. Consignment items are typically taken in at zero cost, so
 * COGS is deliberately left out — subtracting a cost the reseller never paid
 * would shrink a payment somebody else is owed.
 *
 * Pure, and rounded per line item, because this is money leaving the business
 * to a third party. `$10.05 × 33.33%` must not carry fractional cents into a
 * payable, and the per-consignor total has to foot to the cent against the
 * lines it came from.
 */
object ConsignmentReport {

    /** A sold, consigned item flattened to just what the rollup needs. */
    data class SoldConsignedItem(
        val consignorId: String,
        val splitPctOverride: Double?,
        val salePrice: Double,
        val fees: Double,
    )

    fun clampPct(value: Double): Double = minOf(maxOf(value, 0.0), 100.0)

    fun compute(
        soldItems: List<SoldConsignedItem>,
        consignors: List<Consignor>,
    ): List<ConsignmentReportRow> {
        val byId = consignors.associateBy { it.id }
        val rows = mutableMapOf<String, ConsignmentReportRow>()

        for (item in soldItems) {
            // An item pointing at a consignor we don't have is skipped rather
            // than reported under a placeholder name — a payout row for
            // "Unknown" is not something anyone can act on.
            val consignor = byId[item.consignorId] ?: continue
            val split = clampPct(item.splitPctOverride ?: consignor.defaultSplitPct)
            val net = Money.cents(item.salePrice - item.fees)
            // No payout on a loss. A refund-heavy line shouldn't produce a
            // negative "owed" that quietly reduces what another sale earned.
            val payout = Money.cents(maxOf(net, 0.0) * split / 100.0)

            val existing = rows[item.consignorId]
            rows[item.consignorId] = ConsignmentReportRow(
                consignorId = consignor.id,
                consignorName = consignor.name,
                itemsSold = (existing?.itemsSold ?: 0) + 1,
                grossRevenue = Money.cents((existing?.grossRevenue ?: 0.0) + item.salePrice),
                fees = Money.cents((existing?.fees ?: 0.0) + item.fees),
                netProceeds = Money.cents((existing?.netProceeds ?: 0.0) + net),
                consignorPayout = Money.cents((existing?.consignorPayout ?: 0.0) + payout),
                yourCut = Money.cents((existing?.yourCut ?: 0.0) + (net - payout)),
            )
        }

        // Most owed first — that is the order someone pays people in.
        return rows.values.sortedWith(
            compareByDescending<ConsignmentReportRow> { it.consignorPayout }
                .thenBy { it.consignorName },
        )
    }

    /**
     * Join sales to their items over the local cache, keep the consigned ones,
     * and run the rollup.
     *
     * Cancelled and refunded sales are excluded through [SalePnL.isCompleted],
     * so a reversed sale can't generate a payout the reseller never collected.
     * Fees mirror [SalePnL.fees] (platform plus payment processing) so net
     * proceeds — and therefore what's owed — aren't overstated.
     */
    fun compute(
        items: List<InventoryItemEntity>,
        sales: List<SaleEntity>,
        consignors: List<Consignor>,
    ): List<ConsignmentReportRow> {
        val itemsById = items.associateBy { it.id }
        val sold = sales.mapNotNull { sale ->
            if (!SalePnL.isCompleted(sale)) return@mapNotNull null
            val item = itemsById[sale.inventoryItemId] ?: return@mapNotNull null
            val consignorId = item.consignorId ?: return@mapNotNull null
            SoldConsignedItem(
                consignorId = consignorId,
                splitPctOverride = item.consignmentSplitPct,
                salePrice = sale.salePrice,
                fees = SalePnL.fees(sale),
            )
        }
        return compute(sold, consignors)
    }

    /** Total owed across every consignor — the number that gets paid out. */
    fun totalOwed(rows: List<ConsignmentReportRow>): Double =
        Money.sum(rows.map { it.consignorPayout })

    fun totalYourCut(rows: List<ConsignmentReportRow>): Double =
        Money.sum(rows.map { it.yourCut })

    /**
     * How many consigned items are still on hand, so the report says something
     * useful before the first sale lands.
     */
    fun unsoldConsignedCount(
        items: List<InventoryItemEntity>,
        sales: List<SaleEntity>,
    ): Int {
        val soldItemIds = sales.filter { SalePnL.isCompleted(it) }
            .map { it.inventoryItemId }
            .toSet()
        return items.count { it.consignorId != null && it.id !in soldItemIds }
    }

    /** The line the report shows when there is nothing to pay yet. */
    fun emptyMessage(consignorCount: Int, unsoldConsigned: Int): String = when {
        consignorCount == 0 ->
            "Add a consignor first, then set one on an item to start tracking what you owe."
        unsoldConsigned == 0 ->
            "No items are assigned to a consignor yet. Set one on an item's page."
        // The distinction matters: items ARE assigned, they just haven't sold.
        // Nothing is wrong and nothing needs doing.
        else ->
            "$unsoldConsigned consigned ${if (unsoldConsigned == 1) "item is" else "items are"} " +
                "waiting to sell. Payouts appear here once they do."
    }
}
