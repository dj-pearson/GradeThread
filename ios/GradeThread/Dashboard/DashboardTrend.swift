import Charts
import SwiftUI

/// One day's rolled-up selling figures, used to draw the dashboard trend
/// sparkline. Pure value type so the bucketing math is unit-testable
/// without a ModelContainer (same split as ``DashboardRollup``).
struct DashboardTrendPoint: Identifiable, Equatable {
    let date: Date
    let revenue: Double
    let profit: Double
    var id: Date { date }
}

enum DashboardTrend {

    /// Bucket sales into one point per day across the trailing `days` window
    /// (inclusive of today). Days with no sales are present with zeros so the
    /// line has an even x-axis. Profit nets out platform fees + the sold
    /// item's cost basis, mirroring ``DashboardRollup``.
    static func dailySeries(
        sales: [LocalSale],
        items: [LocalInventoryItem],
        days: Int = 14,
        now: Date = .now,
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

        for sale in sales {
            let day = calendar.startOfDay(for: sale.saleDate)
            guard revenueByDay[day] != nil else { continue }  // outside the window
            let cost = costById[sale.inventoryItemId] ?? 0
            revenueByDay[day]! += sale.salePrice
            profitByDay[day]! += sale.salePrice - sale.platformFees - cost
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
    static func hasActivity(_ points: [DashboardTrendPoint]) -> Bool {
        points.contains { $0.revenue != 0 || $0.profit != 0 }
    }
}

/// Compact revenue sparkline for the dashboard. Area + line, no axes — a
/// glanceable shape, not a precise chart.
struct TrendSparkline: View {
    let points: [DashboardTrendPoint]
    var tint: Color = .brandNavy

    var body: some View {
        Chart(points) { point in
            AreaMark(
                x: .value("Day", point.date),
                y: .value("Revenue", point.revenue)
            )
            .interpolationMethod(.catmullRom)
            .foregroundStyle(
                LinearGradient(
                    colors: [tint.opacity(0.28), tint.opacity(0.02)],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )

            LineMark(
                x: .value("Day", point.date),
                y: .value("Revenue", point.revenue)
            )
            .interpolationMethod(.catmullRom)
            .foregroundStyle(tint)
            .lineStyle(StrokeStyle(lineWidth: 2))
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartLegend(.hidden)
        .accessibilityHidden(true)
    }
}
