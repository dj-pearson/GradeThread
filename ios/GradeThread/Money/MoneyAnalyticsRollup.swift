import Foundation

/// US-812 — Money-tab financial analytics parity with the web `/finances`
/// page. Pure rollups over the local SwiftData mirror (same testable split as
/// ``MoneyRollup``/``AnalyticsRollup``/``DashboardRollup``): no view-layer math,
/// so every figure is unit-testable without a ModelContainer.
///
/// Provides the panels the web renders that the iOS Money tab lacked:
/// inventory-aging histogram, time-on-market distribution, a cash-flow series
/// (revenue vs operating expenses vs cost-basis), and a per-item profit/loss
/// list. ROI-by-source is already covered by ``SourceROIRollup`` (reused by the
/// Money view), so it isn't re-derived here.

// MARK: - Result types

/// One age bracket of on-hand (unsold) inventory: how many items fall in it and
/// the cost basis tied up. Mirrors the web `inventory_aging` brackets.
struct AgingBracket: Identifiable, Equatable {
    let label: String
    let count: Int
    /// Cost basis (acquisition price) of the items in this bracket.
    let value: Double
    var id: String { label }
}

/// One days-to-sell bucket of completed sales.
struct TimeOnMarketBucket: Identifiable, Equatable {
    let label: String
    let count: Int
    var id: String { label }
}

/// Time-on-market summary: average days-to-sell + the distribution histogram.
struct TimeOnMarketStats: Equatable {
    /// Mean days from acquisition (item `createdAt`) to sale, across completed
    /// sales with a known item. Nil when there's nothing to average.
    let averageDays: Double?
    let soldCount: Int
    let distribution: [TimeOnMarketBucket]

    static let empty = TimeOnMarketStats(averageDays: nil, soldCount: 0, distribution: [])

    /// Any completed sale measured.
    var hasData: Bool { soldCount > 0 }
}

/// One month of cash flow: money in (revenue) vs money out (operating expenses
/// + cost basis of goods sold that month).
struct CashFlowMonth: Identifiable, Equatable {
    /// "YYYY-M" — stable id for the chart's ForEach.
    let id: String
    let monthStart: Date
    /// Short month label, e.g. "May".
    let label: String
    let revenue: Double
    let expenses: Double
    let costBasis: Double

    /// Revenue minus money out. Single subtraction (the component sums are
    /// already cents-rounded by ``Money``), so no drift accumulates.
    var net: Double { revenue - expenses - costBasis }
}

/// One sold item's realized profit & loss line.
struct ItemProfitRow: Identifiable, Equatable {
    let saleId: String
    let itemId: String
    let title: String
    let saleDate: Date
    /// Gross revenue (sale price + shipping collected).
    let revenue: Double
    let fees: Double
    /// Acquisition cost basis of the item.
    let costBasis: Double
    /// Net profit = revenue − fees − seller costs − cost basis (``SalePnL.net``).
    let netProfit: Double

    /// Return on cost basis; nil when no cost basis was recorded (can't divide
    /// by zero — show "—" rather than a misleading 0% or ∞).
    var roi: Double? { costBasis > 0 ? netProfit / costBasis : nil }

    var id: String { saleId }
}

/// Sort orders for the per-item profit list.
enum ItemProfitSort: String, CaseIterable, Identifiable {
    case recent
    case profit
    case roi

    var id: String { rawValue }

    var label: String {
        switch self {
        case .recent: return "Recent"
        case .profit: return "Profit"
        case .roi: return "ROI"
        }
    }
}

// MARK: - Rollup

enum MoneyAnalyticsRollup {

    // MARK: Inventory aging

    /// Age brackets in display order. `upperDays` is the inclusive upper bound
    /// in days held; the final open bracket has `nil`. Mirrors the web labels.
    static let agingBrackets: [(label: String, upperDays: Int?)] = [
        ("0-14 days", 14),
        ("15-30 days", 30),
        ("31-60 days", 60),
        ("60+ days", nil),
    ]

    /// Whole days an item has been held (from `createdAt` to `now`), clamped at
    /// zero so a future timestamp (clock skew) reads as brand new.
    static func daysHeld(
        _ createdAt: Date, now: Date, calendar: Calendar = .current
    ) -> Int {
        let days = calendar.dateComponents([.day], from: createdAt, to: now).day ?? 0
        return max(days, 0)
    }

    private static func agingLabel(forDays days: Int) -> String {
        for bracket in agingBrackets {
            if let upper = bracket.upperDays {
                if days <= upper { return bracket.label }
            } else {
                return bracket.label
            }
        }
        return agingBrackets.last?.label ?? "60+ days"
    }

    /// On-hand (unsold) inventory bucketed by how long it's been held, with the
    /// cost basis tied up in each bracket. Always returns all four brackets in
    /// order (zero-filled) so the histogram's x-axis is stable; the view shows
    /// an empty state when every count is zero.
    static func inventoryAging(
        items: [LocalInventoryItem],
        now: Date,
        calendar: Calendar = .current
    ) -> [AgingBracket] {
        var counts: [String: Int] = [:]
        var values: [String: [Double]] = [:]
        for item in items where DashboardRollup.isOnHand(item.status) {
            let label = agingLabel(forDays: daysHeld(item.createdAt, now: now, calendar: calendar))
            counts[label, default: 0] += 1
            values[label, default: []].append(item.acquiredPrice ?? 0)
        }
        return agingBrackets.map { bracket in
            AgingBracket(
                label: bracket.label,
                count: counts[bracket.label] ?? 0,
                // US-790: exact-Decimal sum so the tied-up capital foots to the cent.
                value: Money.sum(values[bracket.label] ?? [])
            )
        }
    }

    // MARK: Time on market

    /// Days-to-sell distribution buckets (inclusive upper bound; final open).
    static let timeOnMarketBuckets: [(label: String, upperDays: Int?)] = [
        ("≤7 days", 7),
        ("8-30 days", 30),
        ("31-60 days", 60),
        ("61-90 days", 90),
        ("90+ days", nil),
    ]

    private static func timeOnMarketLabel(forDays days: Int) -> String {
        for bucket in timeOnMarketBuckets {
            if let upper = bucket.upperDays {
                if days <= upper { return bucket.label }
            } else {
                return bucket.label
            }
        }
        return timeOnMarketBuckets.last?.label ?? "90+ days"
    }

    /// Average + distribution of days-to-sell across completed sales. Days are
    /// measured from the item's acquisition (`createdAt`) to the sale date; a
    /// sale whose item isn't in the local mirror is skipped (no acquisition
    /// date to anchor on). A negative span (sale predates the cached
    /// `createdAt`) clamps to zero.
    static func timeOnMarket(
        items: [LocalInventoryItem],
        sales: [LocalSale],
        now: Date = .now,
        calendar: Calendar = .current
    ) -> TimeOnMarketStats {
        var createdById: [String: Date] = [:]
        for item in items { createdById[item.id] = item.createdAt }

        var spans: [Int] = []
        for sale in sales where SalePnL.isCompleted(sale) {
            guard let created = createdById[sale.inventoryItemId] else { continue }
            let days = calendar.dateComponents([.day], from: created, to: sale.saleDate).day ?? 0
            spans.append(max(days, 0))
        }
        guard !spans.isEmpty else { return .empty }

        let average = Double(spans.reduce(0, +)) / Double(spans.count)
        var counts: [String: Int] = [:]
        for span in spans { counts[timeOnMarketLabel(forDays: span), default: 0] += 1 }
        let distribution = timeOnMarketBuckets.map {
            TimeOnMarketBucket(label: $0.label, count: counts[$0.label] ?? 0)
        }
        return TimeOnMarketStats(
            averageDays: (average * 10).rounded() / 10,
            soldCount: spans.count,
            distribution: distribution
        )
    }

    // MARK: Cash flow

    /// Cash-flow series for the trailing `months` months, oldest → newest
    /// (current month last). Revenue = completed-sale revenue in the month;
    /// expenses = operating expenses dated in the month; cost basis = COGS of
    /// the items those sales moved.
    static func cashFlow(
        items: [LocalInventoryItem],
        sales: [LocalSale],
        expenses: [LocalExpense],
        now: Date,
        months: Int = 6,
        calendar: Calendar = .current
    ) -> [CashFlowMonth] {
        let monthFormatter = DateFormatter()
        monthFormatter.locale = Locale(identifier: "en_US_POSIX")
        monthFormatter.dateFormat = "MMM"
        monthFormatter.timeZone = calendar.timeZone

        var costById: [String: Double] = [:]
        for item in items { costById[item.id] = item.acquiredPrice ?? 0 }

        let startOfMonth = calendar.date(
            from: calendar.dateComponents([.year, .month], from: now)
        ) ?? now

        var result: [CashFlowMonth] = []
        for offset in stride(from: months - 1, through: 0, by: -1) {
            guard let mStart = calendar.date(byAdding: .month, value: -offset, to: startOfMonth)
            else { continue }
            let mEnd = calendar.date(byAdding: .month, value: 1, to: mStart) ?? mStart

            let monthSales = sales.filter {
                $0.saleDate >= mStart && $0.saleDate < mEnd && SalePnL.isCompleted($0)
            }
            let revenue = Money.sum(monthSales) { SalePnL.revenue($0) }
            let costBasis = Money.sum(monthSales) { costById[$0.inventoryItemId] ?? 0 }
            let monthExpenses = Money.sum(
                expenses.filter { $0.spentOn >= mStart && $0.spentOn < mEnd }
            ) { $0.amount }

            let comps = calendar.dateComponents([.year, .month], from: mStart)
            result.append(CashFlowMonth(
                id: "\(comps.year ?? 0)-\(comps.month ?? 0)",
                monthStart: mStart,
                label: monthFormatter.string(from: mStart),
                revenue: revenue,
                expenses: monthExpenses,
                costBasis: costBasis
            ))
        }
        return result
    }

    // MARK: Per-item P&L

    /// One profit/loss row per completed sale, joined to its item for the title
    /// and cost basis. Default order is most-recent first; use ``sortProfitRows``
    /// to re-order. A sale with no matching local item still produces a row
    /// (zero cost basis, "Untitled item") so realized revenue is never dropped.
    static func itemProfitRows(
        items: [LocalInventoryItem],
        sales: [LocalSale]
    ) -> [ItemProfitRow] {
        var costById: [String: Double] = [:]
        var titleById: [String: String] = [:]
        for item in items {
            costById[item.id] = item.acquiredPrice ?? 0
            titleById[item.id] = item.title
        }

        return sales
            .filter { SalePnL.isCompleted($0) }
            .map { sale in
                let cost = costById[sale.inventoryItemId] ?? 0
                return ItemProfitRow(
                    saleId: sale.id,
                    itemId: sale.inventoryItemId,
                    title: titleById[sale.inventoryItemId] ?? "Untitled item",
                    saleDate: sale.saleDate,
                    revenue: SalePnL.revenue(sale),
                    fees: SalePnL.fees(sale),
                    costBasis: cost,
                    netProfit: SalePnL.net(sale, costBasis: cost)
                )
            }
            .sorted { $0.saleDate > $1.saleDate }
    }

    /// Re-order profit rows. ROI sorts rows with no ROI (no cost basis) last so
    /// the meaningful ones surface first; ties break on most-recent sale.
    static func sortProfitRows(
        _ rows: [ItemProfitRow], by sort: ItemProfitSort
    ) -> [ItemProfitRow] {
        switch sort {
        case .recent:
            return rows.sorted { $0.saleDate > $1.saleDate }
        case .profit:
            return rows.sorted {
                if $0.netProfit != $1.netProfit { return $0.netProfit > $1.netProfit }
                return $0.saleDate > $1.saleDate
            }
        case .roi:
            return rows.sorted {
                switch ($0.roi, $1.roi) {
                case let (l?, r?):
                    if l != r { return l > r }
                    return $0.saleDate > $1.saleDate
                case (.some, .none): return true
                case (.none, .some): return false
                case (.none, .none): return $0.saleDate > $1.saleDate
                }
            }
        }
    }
}
