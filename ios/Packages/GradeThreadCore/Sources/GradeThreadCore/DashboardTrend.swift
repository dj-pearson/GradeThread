import Foundation

/// A sale that also carries the fields the trend bucketing needs beyond the
/// money math: which day it landed on and which item it drew its cost basis
/// from. Refines ``SaleFinancials`` so ``SalePnL`` still applies. The app's
/// `LocalSale` `@Model` conforms via a one-line empty extension.
public protocol DatedSale: SaleFinancials {
    var saleDate: Date { get }
    var inventoryItemId: String { get }
}

/// An inventory item reduced to what the trend needs: its id (to match a sale)
/// and its acquisition price (the cost basis). The app's `LocalInventoryItem`
/// `@Model` conforms via a one-line empty extension.
public protocol ItemCost {
    var id: String { get }
    var acquiredPrice: Double? { get }
}

/// One day's rolled-up selling figures, used to draw the dashboard trend
/// sparkline. Pure value type so the bucketing math is unit-testable without a
/// ModelContainer (same split as ``DashboardRollup``). The `TrendSparkline`
/// SwiftUI/Charts view that renders these stays in the app.
public struct DashboardTrendPoint: Identifiable, Equatable {
    public let date: Date
    public let revenue: Double
    public let profit: Double
    public var id: Date { date }

    public init(date: Date, revenue: Double, profit: Double) {
        self.date = date
        self.revenue = revenue
        self.profit = profit
    }
}

public enum DashboardTrend {

    /// Bucket sales into one point per day across the trailing `days` window
    /// (inclusive of today). Days with no sales are present with zeros so the
    /// line has an even x-axis. Revenue + profit go through ``SalePnL`` (revenue =
    /// price + shipping collected; net = revenue − all fees − seller costs − cost
    /// basis) and only COMPLETED sales count, so the sparkline agrees with the
    /// ``DashboardMetrics`` KPI card above it instead of double-counting refunds
    /// or using a divergent fees-only profit formula.
    public static func dailySeries<S: DatedSale, I: ItemCost>(
        sales: [S],
        items: [I],
        days: Int = 14,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [DashboardTrendPoint] {
        guard days > 0 else { return [] }

        var costById: [String: Double] = [:]
        for item in items { costById[item.id] = item.acquiredPrice ?? 0 }

        let today = calendar.startOfDay(for: now)
        guard let startDay = calendar.date(byAdding: .day, value: -(days - 1), to: today) else {
            return []
        }

        // Seed every day in the window so gaps render as zero, not skipped.
        var revenueByDay: [Date: Double] = [:]
        var profitByDay: [Date: Double] = [:]
        var orderedDays: [Date] = []
        for offset in 0..<days {
            guard let day = calendar.date(byAdding: .day, value: offset, to: startDay) else { continue }
            revenueByDay[day] = 0
            profitByDay[day] = 0
            orderedDays.append(day)
        }

        for sale in sales where SalePnL.isCompleted(sale) {
            let day = calendar.startOfDay(for: sale.saleDate)
            guard revenueByDay[day] != nil else { continue }  // outside the window
            let cost = costById[sale.inventoryItemId] ?? 0
            revenueByDay[day]! += SalePnL.revenue(sale)
            profitByDay[day]! += SalePnL.net(sale, costBasis: cost)
        }

        return orderedDays.map {
            DashboardTrendPoint(
                date: $0,
                revenue: revenueByDay[$0] ?? 0,
                profit: profitByDay[$0] ?? 0
            )
        }
    }

    /// Whether the window has any activity worth charting.
    public static func hasActivity(_ points: [DashboardTrendPoint]) -> Bool {
        points.contains { $0.revenue != 0 || $0.profit != 0 }
    }
}
