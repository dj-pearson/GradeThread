import Foundation

/// US-677 — per-source ROI + sourcing-budget math, rolled up over the local
/// SwiftData mirror exactly like ``AnalyticsRollup``/``MoneyRollup``: pure
/// functions over `@Query` arrays so the arithmetic is unit-testable without a
/// ModelContainer. ``AnalyticsView`` feeds it items/sales/sources and renders
/// the result. Mirrors the web `sources.tsx` source grouping.
///
/// Item→source linkage comes from ``LocalInventoryItem/sourceId`` (added in
/// US-677 and synced from `inventory_items.source_id`). Items with no source
/// roll up under a single "No source" bucket so spend always reconciles.

// MARK: - Result types

/// Profit + sell-through for one acquisition source.
struct SourceROIRow: Identifiable, Equatable {
    /// `sources.id`, or nil for the unattributed bucket.
    let sourceId: String?
    let sourceName: String
    /// Items acquired from this source (any status).
    let acquiredCount: Int
    /// Of those, how many have sold.
    let soldCount: Int
    /// Total acquisition cost sunk into this source (all items).
    let spend: Double
    /// Gross sale price of the sold items.
    let revenue: Double
    /// Marketplace fees on the sold items.
    let fees: Double
    /// Acquisition cost of just the sold items (COGS).
    let cogs: Double

    /// Realized net profit = revenue − fees − COGS of sold items.
    var netProfit: Double { revenue - fees - cogs }
    /// Return on total sourcing spend; nil when nothing was spent.
    var roi: Double? { spend > 0 ? netProfit / spend : nil }
    /// Fraction of acquired items that have sold.
    var sellThrough: Double { acquiredCount > 0 ? Double(soldCount) / Double(acquiredCount) : 0 }

    var id: String { sourceId ?? "__none__" }
}

/// Spend-vs-budget status over a period.
struct SourcingBudgetStatus: Equatable {
    let budget: Double
    let spent: Double
    var remaining: Double { budget - spent }
    /// 0…1 progress (clamped) for a meter.
    var fraction: Double { budget > 0 ? min(spent / budget, 1) : 0 }
    // US-1196: a zero/unset budget isn't "over budget" — require a positive
    // budget so a garbage/empty input doesn't render "Over budget" + empty bar.
    var isOver: Bool { budget > 0 && spent > budget }
}

// MARK: - Rollup

enum SourceROIRollup {

    /// The bucket label used when an item has no source attribution.
    static let unattributedName = "No source"

    /// Net profit / sell-through grouped by acquisition source, highest profit
    /// first. `sources` supplies display names; unknown ids fall back to a
    /// short id so the row is never blank.
    static func bySource(
        items: [LocalInventoryItem],
        sales: [LocalSale],
        sources: [LocalSource]
    ) -> [SourceROIRow] {
        let nameById = Dictionary(
            sources.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first }
        )

        // Per-item cost + source, and a fast item→source lookup for sales.
        var sourceByItem: [String: String?] = [:]
        var costByItem: [String: Double] = [:]
        struct Agg {
            var acquired = 0
            var sold = 0
            var spend = 0.0
            var revenue = 0.0
            var fees = 0.0
            var cogs = 0.0
        }
        var agg: [String: Agg] = [:]     // keyed by sourceId ?? sentinel
        let sentinel = "__none__"

        for item in items {
            let key = item.sourceId ?? sentinel
            sourceByItem[item.id] = item.sourceId
            costByItem[item.id] = item.acquiredPrice ?? 0
            agg[key, default: Agg()].acquired += 1
            agg[key, default: Agg()].spend += (item.acquiredPrice ?? 0)
        }

        for sale in sales {
            // Only completed sales count toward source ROI — a cancelled/refunded
            // sale was reversed and must not inflate revenue/profit (mirrors the
            // Money/Dashboard rollups and ConsignmentReport). US-1269.
            guard SalePnL.isCompleted(sale) else { continue }
            // Attribute the sale to the item's source (sentinel if unknown item).
            let itemSource = (sourceByItem[sale.inventoryItemId] ?? nil)
            let key = itemSource ?? sentinel
            // A sale for an item we don't have locally still counts revenue but
            // can't add COGS — guard the agg so it appears under "No source".
            agg[key, default: Agg()].sold += 1
            agg[key, default: Agg()].revenue += sale.salePrice
            // All marketplace fees (platform + payment processing), matching
            // SalePnL.fees — platformFees alone understated fees and overstated
            // net profit / ROI.
            agg[key, default: Agg()].fees += SalePnL.fees(sale)
            agg[key, default: Agg()].cogs += (costByItem[sale.inventoryItemId] ?? 0)
        }

        return agg.map { key, a in
            let sourceId: String? = (key == sentinel) ? nil : key
            let name = sourceId.flatMap { nameById[$0] } ?? (sourceId.map { "Source \($0.prefix(6))" } ?? unattributedName)
            return SourceROIRow(
                sourceId: sourceId,
                sourceName: name,
                acquiredCount: a.acquired,
                soldCount: a.sold,
                spend: a.spend,
                revenue: a.revenue,
                fees: a.fees,
                cogs: a.cogs
            )
        }
        .sorted { lhs, rhs in
            if lhs.netProfit != rhs.netProfit { return lhs.netProfit > rhs.netProfit }
            return lhs.sourceName < rhs.sourceName
        }
    }

    /// Sourcing spend vs the user's budget over a window. `since` bounds the
    /// spend by item creation date (the catalog timestamp ≈ acquisition date —
    /// the item mirror carries no separate acquired_at). Pass nil for all-time.
    static func budgetStatus(
        items: [LocalInventoryItem],
        budget: Double,
        since: Date?
    ) -> SourcingBudgetStatus {
        let scoped = since.map { start in items.filter { $0.createdAt >= start } } ?? items
        let spent = Money.sum(scoped) { $0.acquiredPrice ?? 0 }
        return SourcingBudgetStatus(budget: budget, spent: spent)
    }
}
