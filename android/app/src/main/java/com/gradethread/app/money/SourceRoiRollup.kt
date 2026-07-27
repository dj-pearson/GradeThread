package com.gradethread.app.money

import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.sync.db.SaleEntity
import com.gradethread.app.sync.db.SourceEntity

/**
 * US-677 / US-1363 (iOS `SourceROIRollup`): per-source ROI and sell-through.
 *
 * Item→source linkage is `inventory_items.source_id`. Items with no source roll
 * up under a single "No source" bucket so spend always RECONCILES against the
 * total — dropping them would make the panel's spend quietly disagree with the
 * cash-flow chart on the same screen.
 */
data class SourceRoiRow(
    /** `sources.id`, or null for the unattributed bucket. */
    val sourceId: String?,
    val sourceName: String,
    /** Items acquired from this source, any status. */
    val acquiredCount: Int,
    val soldCount: Int,
    /** Total acquisition cost sunk into this source (ALL items, not just sold). */
    val spend: Double,
    val revenue: Double,
    val fees: Double,
    /** Acquisition cost of just the sold items (COGS). */
    val cogs: Double,
) {
    val netProfit: Double get() = revenue - fees - cogs

    /** Return on TOTAL sourcing spend; null when nothing was spent. */
    val roi: Double? get() = if (spend > 0) netProfit / spend else null

    val sellThrough: Double
        get() = if (acquiredCount > 0) soldCount.toDouble() / acquiredCount else 0.0
}

object SourceRoiRollup {

    const val UNATTRIBUTED_NAME = "No source"
    private const val SENTINEL = "__none__"

    /**
     * Net profit / sell-through grouped by acquisition source, highest profit
     * first.
     */
    fun bySource(
        items: List<InventoryItemEntity>,
        sales: List<SaleEntity>,
        sources: List<SourceEntity>,
    ): List<SourceRoiRow> {
        val nameById = sources.associate { it.id to it.name }

        class Agg {
            var acquired = 0
            var sold = 0
            val spend = mutableListOf<Double>()
            val revenue = mutableListOf<Double>()
            val fees = mutableListOf<Double>()
            val cogs = mutableListOf<Double>()
        }

        val agg = linkedMapOf<String, Agg>()
        val sourceByItem = mutableMapOf<String, String?>()
        val costByItem = mutableMapOf<String, Double>()

        for (item in items) {
            val key = item.sourceId ?: SENTINEL
            sourceByItem[item.id] = item.sourceId
            costByItem[item.id] = item.acquiredPrice ?: 0.0
            agg.getOrPut(key) { Agg() }.let {
                it.acquired += 1
                it.spend += (item.acquiredPrice ?: 0.0)
            }
        }

        for (sale in sales) {
            // Only completed sales count toward source ROI — a reversed sale
            // must not inflate revenue/profit (US-1269, and 00111 generally).
            if (!SalePnL.isCompleted(sale)) continue
            // A sale for an item we don't hold locally still counts revenue but
            // can't contribute COGS; it lands in the unattributed bucket.
            val key = sourceByItem[sale.inventoryItemId] ?: SENTINEL
            agg.getOrPut(key) { Agg() }.let {
                it.sold += 1
                // Gross sale price, matching iOS — NOT SalePnL.revenue, which
                // adds shipping collected. Sourcing ROI compares what the goods
                // fetched against what they cost; shipping is a pass-through
                // that would flatter a source selling heavy items.
                it.revenue += sale.salePrice
                // ALL marketplace fees (platform + payment processing), matching
                // SalePnL.fees. platformFees alone understated fees and
                // overstated every source's ROI.
                it.fees += SalePnL.fees(sale)
                it.cogs += (costByItem[sale.inventoryItemId] ?: 0.0)
            }
        }

        return agg.map { (key, a) ->
            val sourceId = key.takeIf { it != SENTINEL }
            SourceRoiRow(
                sourceId = sourceId,
                sourceName = sourceId?.let { id ->
                    // An unknown id falls back to a short id so the row is never
                    // blank — the source may not have synced yet.
                    nameById[id]?.takeIf { it.isNotBlank() } ?: "Source ${id.take(6)}"
                } ?: UNATTRIBUTED_NAME,
                acquiredCount = a.acquired,
                soldCount = a.sold,
                // Each money field rounded to whole cents so this panel foots
                // against the Money KPIs, which sum the same values via Money.
                spend = Money.sum(a.spend),
                revenue = Money.sum(a.revenue),
                fees = Money.sum(a.fees),
                cogs = Money.sum(a.cogs),
            )
        }.sortedWith(
            compareByDescending<SourceRoiRow> { it.netProfit }.thenBy { it.sourceName },
        )
    }
}
