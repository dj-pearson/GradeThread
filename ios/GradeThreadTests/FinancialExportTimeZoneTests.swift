import GradeThreadCore
import XCTest
@testable import GradeThread

/// The tax export printed dates in GMT while filtering them in the seller's own
/// zone, so the two disagreed by up to a day at every month boundary.
///
/// `FinancialExportSheet` picks its range with `Calendar.current`, which is
/// right: the seller means their own 1 January. The CSV then rendered every
/// date with a bare `ISO8601DateFormatter`, which is GMT and does not care what
/// the picker meant. The two only agree for a seller sitting on the prime
/// meridian.
final class FinancialExportTimeZoneTests: XCTestCase {

    private static let chicago = TimeZone(identifier: "America/Chicago")!
    private static let sydney = TimeZone(identifier: "Australia/Sydney")!

    func test_anEveningSaleStaysOnTheDayTheSellerSoldIt() throws {
        // 8pm on 31 January in Chicago is already 1 February in GMT.
        let sale = makeSale(price: 100, date: try moment("2026-01-31 20:00", in: Self.chicago))
        let csv = FinancialExport.csv(
            sales: [sale],
            items: [makeItem(cost: 10)],
            start: try moment("2026-01-01 00:00", in: Self.chicago),
            end: try moment("2026-01-31 23:59", in: Self.chicago),
            timeZone: Self.chicago
        )
        XCTAssertTrue(
            csv.contains("2026-01-31,"),
            "a sale the seller made in January must not be dated February in their own export"
        )
        XCTAssertFalse(csv.contains("2026-02-01,"))
        XCTAssertTrue(
            csv.contains("Period,2026-01-01 to 2026-01-31"),
            "the header must name the range the seller picked"
        )
    }

    func test_aMorningSaleAheadOfGmtStaysOnItsOwnDay() throws {
        // 8am on 1 February in Sydney is still 31 January in GMT, so the old
        // formatter dated a February row into January and put it outside the
        // period its own header claimed.
        let sale = makeSale(price: 100, date: try moment("2026-02-01 08:00", in: Self.sydney))
        let csv = FinancialExport.csv(
            sales: [sale],
            items: [makeItem(cost: 10)],
            start: try moment("2026-02-01 00:00", in: Self.sydney),
            end: try moment("2026-02-28 23:59", in: Self.sydney),
            timeZone: Self.sydney
        )
        XCTAssertTrue(csv.contains("2026-02-01,"))
        XCTAssertFalse(csv.contains("2026-01-31,"))
    }

    func test_theFilenameNamesTheSameDaysAsTheHeader() throws {
        let start = try moment("2026-01-01 00:00", in: Self.chicago)
        let end = try moment("2026-01-31 23:59", in: Self.chicago)
        XCTAssertEqual(
            FinancialExport.filename(start: start, end: end, timeZone: Self.chicago),
            "gradethread_financial_report_2026-01-01_2026-01-31.csv",
            "a file named for a different month than it covers is the same bug, filed under a worse name"
        )
    }

    func test_theFormatterIgnoresTheDeviceCalendarAndLocale() {
        // `en_US_POSIX`, same reason MoneyDate.wireFormatter uses it: a device
        // on a Buddhist or Japanese calendar must still emit 2026-01-31.
        let f = FinancialExport.dayFormatter(timeZone: Self.chicago)
        XCTAssertEqual(f.locale?.identifier, "en_US_POSIX")
        XCTAssertEqual(f.timeZone?.identifier, "America/Chicago")
    }

    // MARK: - Helpers

    private func moment(_ text: String, in zone: TimeZone) throws -> Date {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = zone
        f.dateFormat = "yyyy-MM-dd HH:mm"
        return try XCTUnwrap(f.date(from: text), "could not build \(text) in \(zone.identifier)")
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
