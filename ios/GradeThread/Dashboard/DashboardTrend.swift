import Charts
import GradeThreadCore
import SwiftUI

// `DashboardTrendPoint` + the daily-bucketing math (`DashboardTrend`) live in
// GradeThreadCore so they build + unit-test on Linux without a Mac. `LocalSale`
// / `LocalInventoryItem` conform to `DatedSale` / `ItemCost` (see their models)
// so the real `@Model` types flow through the package's generic `dailySeries`.
// Only this SwiftUI/Charts view — which can't leave the app — stays here.

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
