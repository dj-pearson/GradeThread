import Foundation
import GradeThreadCore

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

/// Realized P&L over a period (US-665): revenue, fees, COGS, gross profit.
struct PeriodPnL: Equatable {
    let grossRevenue: Double
    let fees: Double
    let cogs: Double
    var grossProfit: Double { grossRevenue - fees - cogs }
    var unitsSold: Int
}

/// Grading-ROI comparison within a sale-price band: graded vs ungraded sold
/// items and the average net-profit lift from grading (US-665). Mirrors the
/// web `gradingRoiBuckets` shape, bucketed by price band (the local item mirror
/// has no `category` column, so category bucketing is web-only).
struct RoiBucket: Identifiable, Equatable {
    let band: String
    let gradedCount: Int
    let ungradedCount: Int
    let gradedAvgNet: Double?
    let ungradedAvgNet: Double?
    var id: String { band }
    /// Graded avg net minus ungraded avg net, when both sides exist.
    var netProfitLift: Double? {
        guard let g = gradedAvgNet, let u = ungradedAvgNet else { return nil }
        return g - u
    }
    /// Both sides have enough samples to be meaningful.
    var meaningful: Bool { gradedCount >= 3 && ungradedCount >= 3 }
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

    /// Sales in the window that actually count — completed only (cancelled /
    /// refunded excluded, 00111).
    private static func scopedCompletedSales(
        _ sales: [LocalSale], since: Date?
    ) -> [LocalSale] {
        sales.filter { sale in
            guard SalePnL.isCompleted(sale) else { return false }
            if let since { return sale.saleDate >= since }
            return true
        }
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
        // US-1198: use the SAME "is graded" predicate as gradedCount/averageGrade
        // (gradeValue != nil) so the chart total reconciles with the header
        // count; items missing a tier label fall into an "Other" bucket rather
        // than silently dropping out of the distribution.
        let graded = items.filter { $0.gradeValue != nil }
        var counts: [String: Int] = [:]
        var scoreSum: [String: Double] = [:]
        for item in graded {
            let tier = (item.gradeLabel?.isEmpty == false) ? item.gradeLabel! : "Other"
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

        let scoped = scopedCompletedSales(sales, since: since)
        var profit: [String: Double] = [:]
        var units: [String: Int] = [:]
        for sale in scoped {
            let brand = brandById[sale.inventoryItemId] ?? "Unknown"
            let net = SalePnL.net(sale, costBasis: costById[sale.inventoryItemId] ?? 0)
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

    // MARK: Period P&L (US-665)

    /// Realized gross revenue / fees / COGS / gross profit over the window.
    static func periodPnL(
        items: [LocalInventoryItem],
        sales: [LocalSale],
        since: Date?
    ) -> PeriodPnL {
        var costById: [String: Double] = [:]
        for item in items { costById[item.id] = item.acquiredPrice ?? 0 }
        let scoped = scopedCompletedSales(sales, since: since)
        // US-790: exact-Decimal period totals so the P&L foots to the cent.
        let gross = Money.sum(scoped) { SalePnL.revenue($0) }
        let fees = Money.sum(scoped) { SalePnL.fees($0) }
        // COGS = item cost basis + per-sale selling costs (shipping/grading/
        // other), so grossProfit = gross − fees − cogs equals SalePnL.net.
        let cogs = Money.sum(scoped) {
            (costById[$0.inventoryItemId] ?? 0) + SalePnL.sellerCosts($0)
        }
        return PeriodPnL(grossRevenue: gross, fees: fees, cogs: cogs, unitsSold: scoped.count)
    }

    // MARK: Grading ROI (US-665)

    // US-1161: band thresholds are fixed numbers, but the symbol follows the
    // user's currency override / locale rather than a hardcoded "$".
    static var priceBands: [(label: String, range: Range<Double>)] {
        let s = CurrencyFormatter.shared.symbol
        return [
            ("Under \(s)50", 0..<50),
            ("\(s)50–150", 50..<150),
            ("\(s)150+", 150..<Double.greatestFiniteMagnitude),
        ]
    }

    /// US-1274: classify a price against precomputed bands. Takes the bands so
    /// the caller builds the (currency-formatter-backed) labels once instead of
    /// reallocating three CurrencyFormatters per sale in the bucketing loop.
    private static func bandLabel(
        for price: Double,
        in bands: [(label: String, range: Range<Double>)]
    ) -> String {
        bands.first { $0.range.contains(price) }?.label ?? bands.last?.label ?? ""
    }

    /// Graded-vs-ungraded net profit by sale-price band over the window.
    static func gradingRoiBuckets(
        items: [LocalInventoryItem],
        sales: [LocalSale],
        since: Date?
    ) -> [RoiBucket] {
        var costById: [String: Double] = [:]
        var gradedById: [String: Bool] = [:]
        for item in items {
            costById[item.id] = item.acquiredPrice ?? 0
            gradedById[item.id] = (item.gradeValue != nil)
        }
        let scoped = scopedCompletedSales(sales, since: since)
        // US-1274: build the currency-formatted bands once, not once per sale.
        let bands = priceBands

        struct Side { var nets: [Double] = [] }
        var graded: [String: Side] = [:]
        var ungraded: [String: Side] = [:]
        for sale in scoped {
            let band = Self.bandLabel(for: sale.salePrice, in: bands)
            let net = SalePnL.net(sale, costBasis: costById[sale.inventoryItemId] ?? 0)
            if gradedById[sale.inventoryItemId] == true {
                graded[band, default: Side()].nets.append(net)
            } else {
                ungraded[band, default: Side()].nets.append(net)
            }
        }

        func avg(_ nets: [Double]) -> Double? {
            nets.isEmpty ? nil : nets.reduce(0, +) / Double(nets.count)
        }

        return bands.map(\.label).compactMap { band in
            let g = graded[band]?.nets ?? []
            let u = ungraded[band]?.nets ?? []
            guard !g.isEmpty || !u.isEmpty else { return nil }
            return RoiBucket(
                band: band,
                gradedCount: g.count,
                ungradedCount: u.count,
                gradedAvgNet: avg(g),
                ungradedAvgNet: avg(u)
            )
        }
    }

    // MARK: Inventory value

    /// On-hand inventory value grouped by status (reuses the dashboard's
    /// on-hand definition so the figures reconcile).
    static func inventoryValueByStatus(items: [LocalInventoryItem]) -> [StatusValue] {
        var value: [String: Double] = [:]
        var count: [String: Int] = [:]
        for item in items where DashboardRollup.isOnHand(item.status) {
            // Market value (listed price → target → cost basis), matching the
            // Home tab's inventory value.
            value[item.status, default: 0] +=
                (item.listingPrice ?? item.targetPrice ?? item.acquiredPrice ?? 0)
            count[item.status, default: 0] += 1
        }
        return value
            .map { StatusValue(status: $0.key, value: $0.value, count: count[$0.key] ?? 0) }
            .sorted { $0.value > $1.value }
    }
}
