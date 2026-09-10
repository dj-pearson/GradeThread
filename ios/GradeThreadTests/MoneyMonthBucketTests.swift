import Foundation
import GradeThreadCore
import XCTest
@testable import GradeThread

/// US-3302 - month bucketing of an ANCHORED sale date.
///
/// `sales.sale_date` is declared `timestamptz`, but every writer sends a
/// date-only `YYYY-MM-DD` (iOS `SaleRecorder`, the web record-sale dialog, and
/// the Depop/Etsy/Shopify/eBay importers all format or slice a day), so
/// Postgres widens it to midnight UTC. The row is a DAY anchored to UTC, not a
/// moment. `MoneyRollup` and `MoneyAnalyticsRollup` bucketed it with the
/// device's own calendar, so a sale recorded on 1 September - stored at
/// 1 Sep 00:00Z, which is 31 Aug 19:00 in Chicago - fell below a local
/// 1 September boundary and was counted in August, under a heading that read
/// "Aug" because the label came off the same wrong calendar.
///
/// Every test here runs the SAME fixture through two device calendars that sit
/// on opposite sides of UTC. Identical output is the property that matters: a
/// figure that depends on where the phone is cannot be reconciled against the
/// server, which reports `sale_date::date` in a UTC session.
final class MoneyMonthBucketTests: XCTestCase {

    /// UTC-5/-6. West of UTC, where an anchored day reads as the PREVIOUS day.
    private let chicago: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/Chicago")!
        return c
    }()

    /// UTC+9. East of UTC, where local midnight arrives before the anchor does.
    private let tokyo: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        return c
    }()

    /// 2026-09-15T12:00:00Z - mid-month on BOTH sides of the planet (07:00 in
    /// Chicago, 21:00 in Tokyo), so the two devices must agree completely.
    private let midSeptember = MoneyMonthBucketTests.anchoredDay("2026-09-15")
        .addingTimeInterval(12 * 3_600)

    /// A stored money day, anchored exactly the way the server anchors it.
    private static func anchoredDay(_ iso: String) -> Date {
        MoneyDate.parse(iso) ?? .distantPast
    }
    private func day(_ iso: String) -> Date { Self.anchoredDay(iso) }

    // MARK: - AC1 + AC2: the bucket

    func test_saleOnTheFirst_landsInThatMonth_inChicagoAndInTokyo() {
        let sales = [
            makeSale(price: 100, on: "2026-09-01"),
            makeSale(price: 10, on: "2026-09-15"),
            makeSale(price: 999, on: "2026-08-31"),
        ]
        let chi = MoneyRollup.compute(items: [], sales: sales, now: midSeptember, calendar: chicago)
        let tok = MoneyRollup.compute(items: [], sales: sales, now: midSeptember, calendar: tokyo)

        // The 1 September sale is IN September. Before US-3302 the Chicago
        // device returned 10 here and put the 100 in August.
        XCTAssertEqual(chi.revenueThisMonth, 110, accuracy: 0.001)
        XCTAssertEqual(tok.revenueThisMonth, 110, accuracy: 0.001)
        // And the 31 August sale is NOT: the boundary has to hold on both sides.
        XCTAssertEqual(chi.monthlyRevenue.last?.revenue ?? -1, 110, accuracy: 0.001)
    }

    func test_monthSeries_isIdenticalEastAndWestOfUTC() {
        let sales = [
            makeSale(price: 100, on: "2026-09-01"),
            makeSale(price: 40, on: "2026-08-01"),
            makeSale(price: 7, on: "2026-07-31"),
            makeSale(price: 25, on: "2026-06-30"),
        ]
        let chi = MoneyRollup.compute(items: [], sales: sales, now: midSeptember, calendar: chicago)
        let tok = MoneyRollup.compute(items: [], sales: sales, now: midSeptember, calendar: tokyo)

        // MonthlyRevenue is Equatable over id, monthStart, label AND revenue,
        // so this one assertion covers the bucket, its identity and its heading.
        XCTAssertEqual(chi.monthlyRevenue, tok.monthlyRevenue)
        XCTAssertEqual(chi.revenueThisMonth, tok.revenueThisMonth, accuracy: 0.001)
        XCTAssertEqual(chi.netProfitThisMonth, tok.netProfitThisMonth, accuracy: 0.001)

        let byLabel = Dictionary(
            chi.monthlyRevenue.map { ($0.label, $0.revenue) }, uniquingKeysWith: { a, _ in a }
        )
        XCTAssertEqual(byLabel["Sep"] ?? -1, 100, accuracy: 0.001)
        XCTAssertEqual(byLabel["Aug"] ?? -1, 40, accuracy: 0.001)
        XCTAssertEqual(byLabel["Jul"] ?? -1, 7, accuracy: 0.001)
        XCTAssertEqual(byLabel["Jun"] ?? -1, 25, accuracy: 0.001)
    }

    // MARK: - AC3: the label

    func test_monthLabelAndBucketStartComeOffTheSameCalendar() throws {
        let chi = MoneyRollup.compute(items: [], sales: [], now: midSeptember, calendar: chicago)
        let current = try XCTUnwrap(chi.monthlyRevenue.last)
        XCTAssertEqual(current.label, "Sep")
        XCTAssertEqual(current.monthStart, day("2026-09-01"))
        XCTAssertEqual(current.id, "2026-9")
        // The label is a function of the bucket start, not of the device.
        XCTAssertEqual(MoneyDate.monthLabel(current.monthStart), current.label)
    }

    /// The other half of the split: the device still names the month.
    func test_whichMonthIsCurrent_followsTheDeviceNotUTC() {
        // 2026-10-01T01:00Z is 30 September, 8pm in Chicago. The seller is still
        // in September and their September total must not empty out.
        let chicagoEveningOfThe30th = day("2026-10-01").addingTimeInterval(3_600)
        let chi = MoneyRollup.compute(
            items: [],
            sales: [makeSale(price: 100, on: "2026-09-30")],
            now: chicagoEveningOfThe30th,
            calendar: chicago
        )
        XCTAssertEqual(chi.revenueThisMonth, 100, accuracy: 0.001)
        XCTAssertEqual(chi.monthlyRevenue.last?.label, "Sep")

        // 2026-09-30T23:00Z is 1 October, 8am in Tokyo. That seller HAS turned
        // the month over, and a sale dated 1 October is already theirs.
        let tokyoMorningOfThe1st = day("2026-09-30").addingTimeInterval(23 * 3_600)
        let tok = MoneyRollup.compute(
            items: [],
            sales: [makeSale(price: 55, on: "2026-10-01"), makeSale(price: 999, on: "2026-09-30")],
            now: tokyoMorningOfThe1st,
            calendar: tokyo
        )
        XCTAssertEqual(tok.revenueThisMonth, 55, accuracy: 0.001)
        XCTAssertEqual(tok.monthlyRevenue.last?.label, "Oct")
    }

    // MARK: - AC1: cash flow buckets the same way

    func test_cashFlow_bucketsSalesAndExpensesOnTheFirst_identicallyEastAndWest() {
        let item = makeItem(id: "a", cost: 30)
        let sales = [makeSale(itemId: "a", price: 100, on: "2026-09-01")]
        let expenses = [
            makeExpense(amount: 8, on: "2026-09-01"),
            makeExpense(amount: 5, on: "2026-08-31"),
        ]
        let chi = MoneyAnalyticsRollup.cashFlow(
            items: [item], sales: sales, expenses: expenses,
            now: midSeptember, calendar: chicago
        )
        let tok = MoneyAnalyticsRollup.cashFlow(
            items: [item], sales: sales, expenses: expenses,
            now: midSeptember, calendar: tokyo
        )
        XCTAssertEqual(chi, tok)

        let sep = chi.first { $0.label == "Sep" }
        XCTAssertEqual(sep?.revenue ?? -1, 100, accuracy: 0.001)
        XCTAssertEqual(sep?.costBasis ?? -1, 30, accuracy: 0.001)
        XCTAssertEqual(sep?.expenses ?? -1, 8, accuracy: 0.001)
        let aug = chi.first { $0.label == "Aug" }
        XCTAssertEqual(aug?.expenses ?? -1, 5, accuracy: 0.001)
        XCTAssertEqual(aug?.revenue ?? -1, 0, accuracy: 0.001)
    }

    // MARK: - AC5: the export and the tab agree

    /// One fixture, two readers. The CSV is what a seller files taxes with and
    /// the Money tab is what they check on the way to bed; before US-3302 they
    /// disagreed by whatever sold on the 1st, for everyone west of UTC, with
    /// nothing on either surface saying so.
    func test_exportCSVAndMonthTotalAgreeForTheSamePeriod() throws {
        let items = [makeItem(id: "a", cost: 20), makeItem(id: "b", cost: 5)]
        let sales = [
            makeSale(itemId: "a", price: 100, fees: 12, on: "2026-09-01"),
            makeSale(itemId: "b", price: 60, fees: 6, on: "2026-09-15"),
            makeSale(itemId: "a", price: 40, fees: 4, on: "2026-09-30"),
            makeSale(itemId: "b", price: 999, fees: 0, on: "2026-08-31"),
        ]

        for (zone, calendar) in [("Chicago", chicago), ("Tokyo", tokyo)] {
            let metrics = MoneyRollup.compute(
                items: items, sales: sales, now: midSeptember, calendar: calendar
            )
            let csv = FinancialExport.csv(
                sales: sales, items: items,
                startDay: day("2026-09-01"), endDay: day("2026-09-30")
            )
            let lines = csv.components(separatedBy: "\n")
            let gross = try XCTUnwrap(
                lines.first { $0.hasPrefix("Gross Revenue,") },
                "CSV has no summary line in \(zone)"
            )
            XCTAssertEqual(
                gross,
                "Gross Revenue,\(String(format: "%.2f", metrics.revenueThisMonth))",
                "export and Money tab disagree in \(zone)"
            )
            XCTAssertEqual(metrics.revenueThisMonth, 200, accuracy: 0.001, "in \(zone)")
            // The 1 September row is present, printed on the day it was stored.
            XCTAssertTrue(csv.contains("2026-09-01,"), "1 Sep row missing in \(zone)")
            XCTAssertFalse(csv.contains("2026-08-31,"), "31 Aug row leaked in \(zone)")
            XCTAssertEqual(lines.filter { $0.hasPrefix("2026-") }.count, 3, "in \(zone)")
        }
    }

    // MARK: - AC4: the other anchored-date surfaces

    /// The widget's "Sold today" tile read ZERO every day of the year west of
    /// UTC: today's sale is anchored at 00:00Z, which is 7pm YESTERDAY locally,
    /// so it never cleared a local `startOfDay` boundary.
    func test_widgetSoldToday_countsASaleRecordedToday_inChicago() {
        let chicagoAfternoon = day("2026-09-10").addingTimeInterval(19 * 3_600) // 2pm CDT
        let snapshot = WidgetSnapshotPublisher.compute(
            listings: [],
            sales: [makeSale(price: 30, on: "2026-09-10"), makeSale(price: 999, on: "2026-09-09")],
            now: chicagoAfternoon,
            isSignedIn: true,
            calendar: chicago
        )
        XCTAssertEqual(snapshot.soldTodayCount, 1)
        XCTAssertEqual(snapshot.soldTodayGross, 30, accuracy: 0.001)
    }

    /// The dashboard sparkline plotted every sale one day early west of UTC and
    /// left the last day of the axis permanently empty. `DashboardView` fixes
    /// that by ANCHORING both arguments; this asserts the pairing, because
    /// passing one without the other is worse than passing neither.
    func test_dashboardTrend_anchoredWindow_putsTodaysSaleInTheLastBucket() throws {
        let chicagoEvening = day("2026-09-11").addingTimeInterval(2 * 3_600) // 9pm CDT on the 10th
        let series = DashboardTrend.dailySeries(
            sales: [makeSale(price: 40, on: "2026-09-10")],
            items: [LocalInventoryItem](),
            days: 14,
            now: MoneyDate.anchor(localDayOf: chicagoEvening, localCalendar: chicago),
            calendar: MoneyDate.calendar
        )
        XCTAssertEqual(series.count, 14)
        XCTAssertEqual(series.last?.date, day("2026-09-10"))
        let last = try XCTUnwrap(series.last)
        XCTAssertEqual(last.revenue, 40, accuracy: 0.001)
        XCTAssertEqual(series.dropLast().reduce(0) { $0 + $1.revenue }, 0, accuracy: 0.001)
    }

    /// Days held is measured anchor-to-anchor, so it cannot pick up the device's
    /// offset from UTC on the way past a bracket edge.
    func test_daysHeld_isTheSameEastAndWestOfUTC() {
        let acquired = day("2026-08-27")
        let chicagoMorning = day("2026-09-10").addingTimeInterval(13 * 3_600)  // 8am CDT
        let tokyoNight = day("2026-09-10").addingTimeInterval(13 * 3_600)      // 10pm JST, same instant
        XCTAssertEqual(
            MoneyAnalyticsRollup.daysHeld(acquired, now: chicagoMorning, calendar: chicago),
            MoneyAnalyticsRollup.daysHeld(acquired, now: tokyoNight, calendar: tokyo)
        )
        XCTAssertEqual(
            MoneyAnalyticsRollup.daysHeld(acquired, now: chicagoMorning, calendar: chicago), 14
        )
    }

    /// Both ends of a time-on-market span are anchored days, so the span must
    /// not shorten when it crosses a DST change (2026-11-01 in the US).
    func test_timeOnMarket_spanSurvivesADSTChange() {
        let item = makeItem(id: "a", cost: 0)
        item.acquiredDate = day("2026-10-20")
        let sale = makeSale(itemId: "a", price: 50, on: "2026-11-19")
        let stats = MoneyAnalyticsRollup.timeOnMarket(
            items: [item], sales: [sale], now: day("2026-11-20"), calendar: chicago
        )
        XCTAssertEqual(stats.averageDays ?? -1, 30, accuracy: 0.001)
    }

    // MARK: - Helpers

    private func makeItem(id: String, cost: Double) -> LocalInventoryItem {
        let item = LocalInventoryItem(id: id, userId: "u", title: "Item \(id)", status: "sold")
        item.acquiredPrice = cost
        return item
    }

    private func makeSale(
        itemId: String = "x", price: Double, fees: Double = 0, on iso: String
    ) -> LocalSale {
        LocalSale(
            id: UUID().uuidString,
            inventoryItemId: itemId,
            salePrice: price,
            saleDate: day(iso),
            platformFees: fees
        )
    }

    private func makeExpense(amount: Double, on iso: String) -> LocalExpense {
        LocalExpense(id: UUID().uuidString, category: "supplies", amount: amount, spentOn: day(iso))
    }
}
