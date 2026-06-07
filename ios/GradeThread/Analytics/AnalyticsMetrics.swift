import Foundation

/// Reseller analytics rolled up over the local SwiftData mirror — same pattern
/// as ``DashboardRollup``/``MoneyRollup``: pure functions over `@Query` arrays
/// so the math is unit-testable without a ModelContainer. ``AnalyticsView`` feeds
/// it the item/sale arrays and renders the result with Swift Charts.
///
/// Scope is bounded by what the local mirror carries: grade tier (`gradeLabel`/
/// `gradeValue`), `brand`, `status`, `acquiredPrice`, and sales. Source-/
/// category-level analytics and payout reconciliation are web-only for now (the
/// item mirror has no category/source columns; reconciliation needs the edge).

// MARK: - Result types

/// One grade-tier slice of the graded inventory.
struct GradeBucket: Identifiable, Equatable {
    let tier: String
    let count: Int
    var id: String { tier }
}

/// Net profit attributed to a brand over the selected window.
struct BrandProfit: Identifiable, Equatable {
    let brand: String
    let netProfit: Double
    let unitsSold: Int
    var id: String { brand }
}

/// Sell-through for a brand: how many of the items that reached market have sold.
struct SellThroughRow: Identifiable, Equatable {
    let brand: String
    let listed: Int        // items that reached market (listed or terminal-sold)
    let sold: Int
    var rate: Double { listed > 0 ? Double(sold) / Double(listed) : 0 }
    var id: String { brand }
}

/// On-hand inventory value grouped by pipeline status.
struct StatusValue: Identifiable, Equatable {
    let status: String
    let value: Double
    let count: Int
    var id: String { status }
}

// MARK: - Time range

/// Trailing window for sales-based analytics.
enum AnalyticsRange: String, CaseIterable, Identifiable {
    case days30
    case days90
    case days365
    case all

    var id: String { rawValue }

    var label: String {
        switch self {
        case .days30: return "30 days"
        case .days90: return "90 days"
        case .days365: return "12 months"
        case .all: return "All time"
        }
    }

    /// Inclusive start of the window, or nil for all-time.
    func start(now: Date, calendar: Calendar = .current) -> Date? {
        switch self {
        case .all: return nil
        case .days30: return calendar.date(byAdding: .day, value: -30, to: now)
        case .days90: return calendar.date(byAdding: .day, value: -90, to: now)
        case .days365: return calendar.date(byAdding: .day, value: -365, to: now)
        }
    }
}

// MARK: - Rollup

enum AnalyticsRollup {

    /// Statuses representing a realized sale.
    static let soldStatuses: Set<String> = ["sold", "shipped", "completed"]
    /// Statuses representing an item that reached the market.
    static let marketStatuses: Set<String> = ["listed", "sold", "shipped", "completed"]

    private static func brandKey(_ item: LocalInventoryItem) -> String {
        if let brand = item.brand, !brand.isEmpty { return brand }
        return "Unknown"
    }

    // MARK: Grading

    /// Count of items that carry a grade.
    static func gradedCount(items: [LocalInventoryItem]) -> Int {
        items.filter { $0.gradeValue != nil }.count
    }

    /// Mean grade across graded items, rounded to one decimal. Nil if none.
    static func averageGrade(items: [LocalInventoryItem]) -> Double? {
        let values = items.compactMap(\.gradeValue)
        guard !values.isEmpty else { return nil }
        return (values.reduce(0, +) / Double(values.count) * 10).rounded() / 10
    }

    /// Graded items grouped by tier, ordered high → low grade.
    static func gradeDistribution(items: [LocalInventoryItem]) -> [GradeBucket] {
        let graded = items.filter { ($0.gradeLabel?.isEmpty == false) }
        var counts: [String: Int] = [:]
        var scoreSum: [String: Double] = [:]
        for item in graded {
            guard let tier = item.gradeLabel else { continue }
            counts[tier, default: 0] += 1
            scoreSum[tier, default: 0] += (item.gradeValue ?? 0)
        }
        return counts
            .map { GradeBucket(tier: $0.key, count: $0.value) }
            .sorted { lhs, rhs in
                let lScore = (scoreSum[lhs.tier] ?? 0) / Double(max(lhs.count, 1))
                let rScore = (scoreSum[rhs.tier] ?? 0) / Double(max(rhs.count, 1))
                if lScore != rScore { return lScore > rScore }
                return lhs.tier < rhs.tier
            }
    }

    // MARK: Profit by brand

    /// Top brands by net profit (salePrice − fees − cost basis) over the window.
    static func topBrandsByProfit(
        items: [LocalInventoryItem],
        sales: [LocalSale],
        since: Date?,
        limit: Int = 5
    ) -> [BrandProfit] {
        var costById: [String: Double] = [:]
        var brandById: [String: String] = [:]
        for item in items {
            costById[item.id] = item.acquiredPrice ?? 0
            brandById[item.id] = brandKey(item)
        }

        let scoped = since.map { start in sales.filter { $0.saleDate >= start } } ?? sales
        var profit: [String: Double] = [:]
        var units: [String: Int] = [:]
        for sale in scoped {
            let brand = brandById[sale.inventoryItemId] ?? "Unknown"
            let net = sale.salePrice - sale.platformFees - (costById[sale.inventoryItemId] ?? 0)
            profit[brand, default: 0] += net
            units[brand, default: 0] += 1
        }

        return profit
            .map { BrandProfit(brand: $0.key, netProfit: $0.value, unitsSold: units[$0.key] ?? 0) }
            .sorted { $0.netProfit > $1.netProfit }
            .prefix(limit)
            .map { $0 }
    }

    // MARK: Sell-through

    /// Sell-through by brand, considering only items that reached the market.
    static func sellThroughByBrand(
        items: [LocalInventoryItem],
        limit: Int = 8
    ) -> [SellThroughRow] {
        var listed: [String: Int] = [:]
        var sold: [String: Int] = [:]
        for item in items where marketStatuses.contains(item.status) {
            let brand = brandKey(item)
            listed[brand, default: 0] += 1
            if soldStatuses.contains(item.status) {
                sold[brand, default: 0] += 1
            }
        }
        return listed
            .map { SellThroughRow(brand: $0.key, listed: $0.value, sold: sold[$0.key] ?? 0) }
            .sorted { $0.listed > $1.listed }
            .prefix(limit)
            .map { $0 }
    }

    // MARK: Inventory value

    /// On-hand inventory value grouped by status (reuses the dashboard's
    /// on-hand definition so the figures reconcile).
    static func inventoryValueByStatus(items: [LocalInventoryItem]) -> [StatusValue] {
        var value: [String: Double] = [:]
        var count: [String: Int] = [:]
        for item in items where DashboardRollup.isOnHand(item.status) {
            value[item.status, default: 0] += (item.acquiredPrice ?? 0)
            count[item.status, default: 0] += 1
        }
        return value
            .map { StatusValue(status: $0.key, value: $0.value, count: count[$0.key] ?? 0) }
            .sorted { $0.value > $1.value }
    }
}
