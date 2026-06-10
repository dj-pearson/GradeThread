import Foundation

/// Glanceable home-screen rollup over the local SwiftData mirror. Pure
/// scalars only so the math is unit-testable without a ModelContainer —
/// the same split as ``WidgetSnapshotPublisher``. ``DashboardView`` feeds
/// it the `@Query` arrays and renders the result.
struct DashboardMetrics: Equatable {
    /// MARKET value of goods physically on hand: Σ listing price (→ target
    /// price → cost basis) for on-hand items. Matches eBay's reported value
    /// and the web overview's market-value "inventory value".
    let inventoryValue: Double
    /// Count of unsold items on hand (the inventoryValue denominator).
    let onHandCount: Int
    /// Items currently in the `listed` status.
    let listedCount: Int

    /// Sales in the trailing 7-day window.
    let soldThisWeekCount: Int
    /// Gross sale price summed across the trailing-7-day sales.
    let revenueThisWeek: Double
    /// revenue − fees − cost basis of the items those sales moved. Cost
    /// basis is looked up per sale via `inventoryItemId`; an orphan sale
    /// (no matching item) contributes zero cost, never a crash.
    let netProfitThisWeek: Double

    /// On-hand items untouched for `agingThresholdDays`+ — capital sitting
    /// idle that's worth a nudge.
    let agingCount: Int

    static let empty = DashboardMetrics(
        inventoryValue: 0, onHandCount: 0, listedCount: 0,
        soldThisWeekCount: 0, revenueThisWeek: 0, netProfitThisWeek: 0,
        agingCount: 0
    )
}

/// Pure rollup + the shared on-hand / aging predicates. Keeping the
/// predicates here (rather than inline in the view) means the metric count
/// and the aging *list* the view renders can't drift apart.
enum DashboardRollup {

    /// Statuses for unsold inventory still on hand — capital is tied up
    /// until the item sells. Everything else (`sold`, `shipped`,
    /// `completed`, `returned`, `archived`, `keeping`, `wearing`) is either
    /// realized or deliberately set aside, so it doesn't count as on-hand
    /// value. Derived from ``InventoryStage/allKnownStatuses`` minus those
    /// terminal/parked states, so adding a pipeline status in one place
    /// keeps this honest.
    static let onHandStatuses: Set<String> = Set(
        InventoryStage.allKnownStatuses
    ).subtracting([
        "sold", "shipped", "completed", "returned",
        "archived", "keeping", "wearing",
    ])

    /// Days an on-hand item can sit untouched before it's "aging". Matches
    /// the web overview's 14-day threshold.
    static let agingThresholdDays = 14

    /// Trailing window for the "this week" figures. 7×24h rather than a
    /// calendar week so the labeling ("Past 7 days") is unambiguous across
    /// locales and week-start conventions.
    static let weekWindowDays = 7

    static func isOnHand(_ status: String) -> Bool {
        onHandStatuses.contains(status)
    }

    /// On-hand and untouched for `agingThresholdDays`+. A future `updatedAt`
    /// (clock skew) reads as not-aging rather than wildly aging.
    static func isAging(
        _ item: LocalInventoryItem,
        now: Date,
        calendar: Calendar = .current
    ) -> Bool {
        guard isOnHand(item.status) else { return false }
        guard let cutoff = calendar.date(
            byAdding: .day, value: -agingThresholdDays, to: now
        ) else { return false }
        return item.updatedAt < cutoff
    }

    static func compute(
        items: [LocalInventoryItem],
        sales: [LocalSale],
        now: Date,
        calendar: Calendar = .current
    ) -> DashboardMetrics {
        let onHand = items.filter { isOnHand($0.status) }
        // MARKET value (matches eBay): the item's listed price, falling back to
        // its target price, then cost basis. NOT cost basis alone (which is
        // null for imported items and unrelated to eBay's reported value).
        let inventoryValue = Money.sum(onHand) {
            $0.listingPrice ?? $0.targetPrice ?? $0.acquiredPrice ?? 0
        }
        let listedCount = items.filter { $0.status == "listed" }.count
        let agingCount = items.filter {
            isAging($0, now: now, calendar: calendar)
        }.count

        // Cost-basis lookup so net profit nets out what each sold item cost.
        var costById: [String: Double] = [:]
        for item in items { costById[item.id] = item.acquiredPrice ?? 0 }

        let windowStart = calendar.date(
            byAdding: .day, value: -weekWindowDays, to: now
        ) ?? now
        // Only COMPLETED sales count — a cancelled/refunded order was never a
        // real sale. Profit via the shared SalePnL helper (mirrors web pnl.ts).
        let weekSales = sales.filter {
            $0.saleDate >= windowStart && SalePnL.isCompleted($0)
        }
        let revenue = Money.sum(weekSales) { SalePnL.revenue($0) }
        let netProfit = Money.sum(weekSales) {
            SalePnL.net($0, costBasis: costById[$0.inventoryItemId] ?? 0)
        }

        return DashboardMetrics(
            inventoryValue: inventoryValue,
            onHandCount: onHand.count,
            listedCount: listedCount,
            soldThisWeekCount: weekSales.count,
            revenueThisWeek: revenue,
            netProfitThisWeek: netProfit,
            agingCount: agingCount
        )
    }
}
