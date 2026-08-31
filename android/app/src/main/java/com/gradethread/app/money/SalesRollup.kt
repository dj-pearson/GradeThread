package com.gradethread.app.money

import com.gradethread.app.ui.UiMessage

import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.sync.db.SaleEntity

/** One sale, joined to its item and priced through [SalePnL]. */
data class SaleRow(
    val saleId: String,
    val itemId: String,
    val title: String,
    val saleDateMs: Long,
    val revenue: Double,
    val fees: Double,
    val costBasis: Double,
    val netProfit: Double,
    val statusLabel: UiMessage,
    /**
     * The raw status, kept beside the label.
     *
     * US-2976: the sales screen chose the chip's COLOUR by matching the label
     * against "Refunded" / "Cancelled" / "Pending". Translating the label would
     * have made every one of those fall through to the neutral grey, in
     * Spanish only, with nothing failing - a refunded sale quietly losing the
     * one visual cue that says the money went back.
     */
    val status: String,
    /** False for refunded/cancelled/pending — the row is shown, not summed. */
    val countsTowardTotals: Boolean,
) {
    /** Null when no cost basis was recorded — show "—", never 0%. */
    val roi: Double? get() = if (costBasis > 0) netProfit / costBasis else null
}

data class SalesSummary(
    val rows: List<SaleRow> = emptyList(),
    val completedCount: Int = 0,
    val excludedCount: Int = 0,
    val realizedRevenue: Double = 0.0,
    val realizedProfit: Double = 0.0,
)

/**
 * US-1371: the sales list's math.
 *
 * Pure and separate from the ViewModel so AC3 ("per-item P&L matches the Money
 * rollup math") is a TEST rather than a hope — the assertion compares this
 * against [MoneyAnalyticsRollup.itemProfitRows] directly.
 *
 * Two rules this holds apart:
 *  - the LIST shows every sale, refunded and cancelled included. Hiding them
 *    would make a seller's history disagree with their eBay account;
 *  - the TOTALS count only completed sales (00111), because a reversed order
 *    was never revenue.
 */
object SalesRollup {

    fun compute(sales: List<SaleEntity>, items: List<InventoryItemEntity>): SalesSummary {
        val byId = items.associateBy { it.id }

        val rows = sales
            // Room already orders by saleDate DESC; sorted again so the rollup
            // carries its own ordering guarantee when called from a test.
            .sortedByDescending { it.saleDate }
            .map { sale ->
                val item = byId[sale.inventoryItemId]
                val cost = item?.acquiredPrice ?: 0.0
                SaleRow(
                    saleId = sale.id,
                    itemId = sale.inventoryItemId,
                    // An orphan sale still lists — the item may not have synced
                    // yet, and dropping it would lose realized revenue.
                    title = item?.title?.takeIf { it.isNotBlank() } ?: "Untitled item",
                    saleDateMs = sale.saleDate,
                    revenue = Money.cents(SalePnL.revenue(sale)),
                    fees = Money.cents(SalePnL.fees(sale)),
                    costBasis = Money.cents(cost),
                    netProfit = Money.cents(SalePnL.net(sale, cost)),
                    statusLabel = SalePnL.statusLabel(sale),
                    status = sale.status,
                    countsTowardTotals = SalePnL.isCompleted(sale),
                )
            }

        val completed = rows.filter { it.countsTowardTotals }
        return SalesSummary(
            rows = rows,
            completedCount = completed.size,
            excludedCount = rows.size - completed.size,
            realizedRevenue = Money.sum(completed) { it.revenue },
            realizedProfit = Money.sum(completed) { it.netProfit },
        )
    }
}
