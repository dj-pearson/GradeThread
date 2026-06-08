import Foundation

/// One month's revenue bucket for the chart.
struct MonthlyRevenue: Equatable, Identifiable {
    /// "YYYY-M" — stable id for the chart's ForEach.
    let id: String
    let monthStart: Date
    /// Short month label, e.g. "May".
    let label: String
    let revenue: Double
}

/// This-month financial rollup + a 6-month revenue series. Pure scalars
/// (same testable split as ``DashboardRollup``); operating expenses are
/// layered on in the view since they live server-side, not in SwiftData.
struct MoneyMetrics: Equatable {
    let revenueThisMonth: Double
    /// Revenue − platform fees − cost basis of the items sold (before
    /// operating expenses).
    let grossProfitThisMonth: Double
    /// grossProfit / cost basis. Nil when no cost basis is recorded (can't
    /// divide by zero — show "—" rather than a fake 0%).
    let roiThisMonth: Double?
    /// Last 6 months of revenue, oldest → newest (current month last).
    let monthlyRevenue: [MonthlyRevenue]

    static let empty = MoneyMetrics(
        revenueThisMonth: 0, grossProfitThisMonth: 0, roiThisMonth: nil, monthlyRevenue: []
    )
}

enum MoneyRollup {
    static func compute(
        items: [LocalInventoryItem],
        sales: [LocalSale],
        now: Date,
        calendar: Calendar = .current
    ) -> MoneyMetrics {
        // Build the month-label formatter against the calendar's timezone so
        // bucket boundaries and labels agree (and tests stay deterministic).
        let monthFormatter = DateFormatter()
        monthFormatter.locale = Locale(identifier: "en_US_POSIX")
        monthFormatter.dateFormat = "MMM"
        monthFormatter.timeZone = calendar.timeZone
        var costById: [String: Double] = [:]
        for item in items { costById[item.id] = item.acquiredPrice ?? 0 }

        let startOfMonth = calendar.date(
            from: calendar.dateComponents([.year, .month], from: now)
        ) ?? now

        // Only COMPLETED sales count toward revenue/profit (00111). Profit via
        // the shared SalePnL helper so Money, Home, Analytics + web all agree.
        let monthSales = sales.filter {
            $0.saleDate >= startOfMonth && SalePnL.isCompleted($0)
        }
        let revenue = monthSales.reduce(0.0) { $0 + SalePnL.revenue($1) }
        let cost = monthSales.reduce(0.0) { $0 + (costById[$1.inventoryItemId] ?? 0) }
        let grossProfit = monthSales.reduce(0.0) {
            $0 + SalePnL.net($1, costBasis: costById[$1.inventoryItemId] ?? 0)
        }
        let roi: Double? = cost > 0 ? grossProfit / cost : nil

        // 6-month revenue series, oldest first.
        var months: [MonthlyRevenue] = []
        for offset in stride(from: 5, through: 0, by: -1) {
            guard let mStart = calendar.date(byAdding: .month, value: -offset, to: startOfMonth)
            else { continue }
            let mEnd = calendar.date(byAdding: .month, value: 1, to: mStart) ?? mStart
            let rev = sales
                .filter { $0.saleDate >= mStart && $0.saleDate < mEnd && SalePnL.isCompleted($0) }
                .reduce(0.0) { $0 + SalePnL.revenue($1) }
            let comps = calendar.dateComponents([.year, .month], from: mStart)
            months.append(MonthlyRevenue(
                id: "\(comps.year ?? 0)-\(comps.month ?? 0)",
                monthStart: mStart,
                label: monthFormatter.string(from: mStart),
                revenue: rev
            ))
        }

        return MoneyMetrics(
            revenueThisMonth: revenue,
            grossProfitThisMonth: grossProfit,
            roiThisMonth: roi,
            monthlyRevenue: months
        )
    }
}
