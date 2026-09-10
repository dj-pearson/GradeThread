import GradeThreadCore
import SwiftUI
import XCTest
@testable import GradeThread

/// US-3231 - the tax export's date range slid by the device's offset from UTC,
/// so the first day of a range was dropped and the day after the last was
/// swept in.
///
/// WHAT A STORED SALE DAY ACTUALLY IS, since the column type says otherwise.
/// Every writer of `sales.sale_date` sends a date-only `YYYY-MM-DD`: iOS
/// `SaleRecorder` formats the picked day in the device's own calendar, the web
/// dialog uses an `<input type="date">`, and the Depop/Etsy/Shopify/eBay
/// importers slice ten characters off `sold_at`. The column is `timestamptz`
/// (00002_inventory_financial.sql:71), so Postgres widens that day to midnight
/// UTC, and `finances_export` (00143_finances_dashboard.sql:548) buckets it
/// back with `sale_date::date` in a UTC session. The stored value is a
/// UTC-midnight anchor of a calendar day, not a moment.
///
/// NOTE - THIS FILE REVERSES AN EARLIER ASSERTION, AND THAT IS DELIBERATE. It used to
/// claim the CSV date column should render in `Calendar.current`, with fixtures
/// built as genuine local moments (a sale at "2026-01-31 20:00 in Chicago").
/// No writer produces such a row. Fed a real row - `2026-01-31` stored at
/// `2026-01-31T00:00Z` - local rendering prints `2026-01-30`, one day before
/// the day the seller typed and one day before the day `finances_export`
/// reports for the same sale. The old fixtures were what made the old
/// assertion look right.
final class FinancialExportTimeZoneTests: XCTestCase {

    /// Five hours behind UTC in September (CDT). The zone where the start day
    /// used to be dropped.
    private static let chicago = TimeZone(identifier: "America/Chicago")!
    /// Ten hours ahead of UTC in September (AEST). The zone where the same
    /// arithmetic ran the other way.
    private static let sydney = TimeZone(identifier: "Australia/Sydney")!

    // MARK: - AC1: the pickers bind through MoneyDate.dayPicker

    func test_thePickerBindingAnchorsTheDayTheSellerTapped() throws {
        // Exercises the binding the sheet installs, without a view. The picker
        // works in local time, so it hands back local midnight; the binding
        // re-anchors it to the shape the rows use. Both zones must land on the
        // same instant, because both sellers tapped the same calendar day.
        let anchored = try XCTUnwrap(MoneyDate.parse("2026-09-01"))
        for zone in [Self.chicago, Self.sydney] {
            let stored = try picked("2026-09-01", in: zone)
            XCTAssertEqual(
                stored,
                anchored,
                "a seller in \(zone.identifier) tapping 1 September must produce the "
                    + "same anchored day the server stores for 1 September"
            )
        }
    }

    func test_thePickerBindingRendersTheStoredDayBackToTheSeller() throws {
        // The read half. Handing UTC midnight straight to a DatePicker shows
        // the previous day everywhere west of Greenwich, which is how a seller
        // ends up "correcting" a date that was already right.
        var local = Calendar(identifier: .gregorian)
        local.timeZone = Self.chicago
        let stored = try XCTUnwrap(MoneyDate.parse("2026-09-01"))
        let onScreen = MoneyDate.localMidnight(of: stored, localCalendar: local)
        XCTAssertEqual(local.component(.day, from: onScreen), 1)
        XCTAssertEqual(local.component(.month, from: onScreen), 9)
    }

    // MARK: - AC3: a range whose first and last days both carry rows

    func test_westOfUtcTheFirstAndLastDaysOfTheRangeAreBothExported() throws {
        // The reported bug. Chicago is UTC-5, so the old local-midnight start
        // bound sat five hours AFTER the 1 September anchor and excluded it,
        // while the old local 23:59:59 end bound sat five hours after the
        // 1 October anchor and included that.
        let sales = try ["2026-08-31", "2026-09-01", "2026-09-15", "2026-09-30", "2026-10-01"]
            .map { try storedSale(on: $0, price: 100) }

        let from = try picked("2026-09-01", in: Self.chicago)
        let to = try picked("2026-09-30", in: Self.chicago)
        let csv = FinancialExport.csv(sales: sales, items: [makeItem(cost: 10)], startDay: from, endDay: to)

        XCTAssertTrue(csv.contains("2026-09-01,"), "the first day of the range must not be dropped")
        XCTAssertTrue(csv.contains("2026-09-30,"), "the last day of the range must not be dropped")
        XCTAssertFalse(csv.contains("2026-08-31,"), "the day before the range must not appear")
        XCTAssertFalse(csv.contains("2026-10-01,"), "the day after the range must not appear")
        XCTAssertTrue(
            csv.contains("Period,2026-09-01 to 2026-09-30"),
            "the header must name the days the seller picked"
        )
        // 3 rows at 100 each; nothing from 31 Aug or 1 Oct folded into the total.
        XCTAssertTrue(csv.contains("Gross Revenue,300.00"), "the summary must foot to the rows")
    }

    func test_eastOfUtcTheFirstAndLastDaysOfTheRangeAreBothExported() throws {
        // Sydney is UTC+10, so the old bounds slid the other way: the start
        // bound landed 14 hours BEFORE the first anchor, pulling in the
        // previous day.
        let sales = try ["2026-08-31", "2026-09-01", "2026-09-30", "2026-10-01"]
            .map { try storedSale(on: $0, price: 100) }

        let from = try picked("2026-09-01", in: Self.sydney)
        let to = try picked("2026-09-30", in: Self.sydney)
        let csv = FinancialExport.csv(sales: sales, items: [makeItem(cost: 10)], startDay: from, endDay: to)

        XCTAssertTrue(csv.contains("2026-09-01,"))
        XCTAssertTrue(csv.contains("2026-09-30,"))
        XCTAssertFalse(csv.contains("2026-08-31,"))
        XCTAssertFalse(csv.contains("2026-10-01,"))
        XCTAssertTrue(csv.contains("Gross Revenue,200.00"))
    }

    func test_bothZonesExportTheSameRowsForTheSamePickedDays() throws {
        // The real acceptance test for the whole story: the device's zone must
        // stop changing which rows a range contains.
        let sales = try ["2026-09-01", "2026-09-30"].map { try storedSale(on: $0, price: 100) }
        let items = [makeItem(cost: 10)]

        let westFrom = try picked("2026-09-01", in: Self.chicago)
        let westTo = try picked("2026-09-30", in: Self.chicago)
        let eastFrom = try picked("2026-09-01", in: Self.sydney)
        let eastTo = try picked("2026-09-30", in: Self.sydney)

        let west = FinancialExport.csv(sales: sales, items: items, startDay: westFrom, endDay: westTo)
        let east = FinancialExport.csv(sales: sales, items: items, startDay: eastFrom, endDay: eastTo)
        XCTAssertEqual(west, east, "the same range, picked in two zones, must export the same file")
    }

    // MARK: - AC2: the To bound covers the whole of its day

    func test_aRowStoredOnTheLastDayIsExported() throws {
        let sale = try storedSale(on: "2026-09-30", price: 100)
        let from = try picked("2026-09-01", in: Self.chicago)
        let to = try picked("2026-09-30", in: Self.chicago)
        let txns = boundedTransactions(sales: [sale], startDay: from, endDay: to)
        XCTAssertEqual(txns.count, 1, "a sale dated the last day of the range belongs in the range")
    }

    func test_theLastDayIsCoveredThroughItsFinalFractionOfASecond() throws {
        // The old end bound was `date(bySettingHour: 23, minute: 59, second: 59)`,
        // which excludes 23:59:59.5. Only a genuine-moment row can land there
        // (flipdesk-import writes one from a CSV `sold_at`), but a tax export
        // silently dropping a sale is not a defect worth keeping for its rarity.
        let lastInstant = try XCTUnwrap(MoneyDate.parse("2026-09-30"))
            .addingTimeInterval(86_399.5)
        let firstInstantAfter = try XCTUnwrap(MoneyDate.parse("2026-10-01"))

        let inside = makeSale(price: 100, date: lastInstant)
        let outside = makeSale(price: 999, date: firstInstantAfter)

        let from = try picked("2026-09-01", in: Self.chicago)
        let to = try picked("2026-09-30", in: Self.chicago)
        let txns = boundedTransactions(sales: [inside, outside], startDay: from, endDay: to)
        XCTAssertEqual(txns.count, 1)
        let kept = try XCTUnwrap(txns.first)
        XCTAssertEqual(kept.grossRevenue, 100, accuracy: 0.001)

        let firstDay = try XCTUnwrap(MoneyDate.parse("2026-09-01"))
        let lastDay = try XCTUnwrap(MoneyDate.parse("2026-09-30"))
        let bounds = FinancialExport.dayBounds(startDay: firstDay, endDay: lastDay)
        XCTAssertEqual(
            bounds.end,
            firstInstantAfter,
            "the end bound is exclusive and sits at midnight after the last day"
        )
    }

    // MARK: - Rendering

    func test_theDayTheSellerPickedIsTheDayThatPrints() throws {
        // The round trip, end to end, west of UTC. SaleRecorder formats the
        // picked sale day in the device zone and sends "2026-01-31"; Postgres
        // widens that to 2026-01-31T00:00Z. Rendering it back in
        // America/Chicago says 2026-01-30 - a day before the seller's own
        // entry, and a day before finances_export reports the same row.
        let sale = try storedSale(on: "2026-01-31", price: 100)
        let from = try picked("2026-01-01", in: Self.chicago)
        let to = try picked("2026-01-31", in: Self.chicago)
        let csv = FinancialExport.csv(sales: [sale], items: [makeItem(cost: 10)], startDay: from, endDay: to)
        XCTAssertTrue(csv.contains("2026-01-31,"))
        XCTAssertFalse(
            csv.contains("2026-01-30,"),
            "rendering the anchored day in the device zone loses a day west of UTC"
        )
    }

    func test_theFilenameNamesTheSameDaysAsTheHeader() throws {
        let from = try picked("2026-01-01", in: Self.chicago)
        let to = try picked("2026-01-31", in: Self.chicago)
        XCTAssertEqual(
            FinancialExport.filename(startDay: from, endDay: to),
            "gradethread_financial_report_2026-01-01_2026-01-31.csv",
            "a file named for a different month than it covers is the same bug, filed under a worse name"
        )
    }

    func test_aReversedRangeCollapsesOntoItsStartDayInsteadOfGoingEmpty() throws {
        // The pickers let To sit before From. A Range<Date> would trap here;
        // the bounds clamp instead, and the one day still exports.
        let sale = try storedSale(on: "2026-09-10", price: 100)
        let from = try picked("2026-09-10", in: Self.chicago)
        let to = try picked("2026-09-01", in: Self.chicago)
        let txns = boundedTransactions(sales: [sale], startDay: from, endDay: to)
        XCTAssertEqual(txns.count, 1)
    }

    // MARK: - Helpers

    /// A box, so the `Binding` under test writes somewhere the test can read
    /// without relying on how an escaping closure captures a local `var`.
    private final class DateBox {
        var value: Date = .distantPast
    }

    /// What the From/To pickers hand back when a seller in `zone` taps `day`.
    /// Goes through the real `MoneyDate.dayPicker` binding, which is what the
    /// sheet installs.
    private func picked(_ day: String, in zone: TimeZone) throws -> Date {
        var local = Calendar(identifier: .gregorian)
        local.timeZone = zone
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = zone
        f.dateFormat = "yyyy-MM-dd HH:mm"
        let localMidnight = try XCTUnwrap(
            f.date(from: "\(day) 00:00"),
            "could not build \(day) in \(zone.identifier)"
        )
        let box = DateBox()
        let binding = MoneyDate.dayPicker(
            Binding(get: { box.value }, set: { box.value = $0 }),
            localCalendar: local
        )
        binding.wrappedValue = localMidnight
        return box.value
    }

    /// A sale as the cache actually holds one: the wire's `YYYY-MM-DD` parsed
    /// through the same helper `SyncEngine.parseDateOrNil` uses.
    private func storedSale(on wireDay: String, price: Double) throws -> LocalSale {
        let stored = try XCTUnwrap(MoneyDate.parse(wireDay))
        return makeSale(price: price, date: stored)
    }

    private func boundedTransactions(
        sales: [LocalSale],
        startDay: Date,
        endDay: Date
    ) -> [FinancialExport.Transaction] {
        let bounds = FinancialExport.dayBounds(startDay: startDay, endDay: endDay)
        return FinancialExport.transactions(
            sales: sales,
            items: [makeItem(cost: 10)],
            from: bounds.start,
            until: bounds.end
        )
    }

    private func makeItem(cost: Double) -> LocalInventoryItem {
        let item = LocalInventoryItem(id: "a", userId: "u", title: "Item", status: "sold")
        item.acquiredPrice = cost
        return item
    }

    private func makeSale(price: Double, date: Date) -> LocalSale {
        LocalSale(
            id: UUID().uuidString,
            inventoryItemId: "a",
            salePrice: price,
            saleDate: date,
            platformFees: 0
        )
    }
}
