import XCTest
@testable import GradeThread

/// `03/09/2026` is 3 September in Britain and 9 March in America, and the
/// importer used to assume America every time.
///
/// That is worse than the dropped cells US-3270 reports, because nothing looks
/// wrong: the cell parses, the row imports, and the acquired date - which
/// drives aging and every tax-year boundary - is six months out.
///
/// The fix reads the order off the whole column instead of one cell. A column
/// is written by one person in one format, so a single unambiguous value in it
/// settles every other value.
final class ImportDateOrderTests: XCTestCase {

    private let us = Locale(identifier: "en_US")
    private let gb = Locale(identifier: "en_GB")

    // MARK: - Reading the column

    func test_oneUnambiguousValueSettlesTheWholeColumn() {
        // 13 cannot be a month, so this column is day-first, and every other
        // value in it is read that way - including the ones that would parse
        // perfectly well as month-first.
        XCTAssertEqual(
            ImportValue.slashOrder(in: ["03/09/2026", "13/04/2026"], locale: us),
            .dayFirst
        )
        // And the mirror: 13 in second place can only be a day.
        XCTAssertEqual(
            ImportValue.slashOrder(in: ["03/09/2026", "04/13/2026"], locale: gb),
            .monthFirst
        )
    }

    func test_aColumnThatSettlesItselfBeatsTheDeviceLocale() {
        // A British seller pasting an American export must not have it reread.
        XCTAssertEqual(
            ImportValue.slashOrder(in: ["12/25/2026"], locale: gb),
            .monthFirst
        )
    }

    func test_anAmbiguousColumnFallsBackToTheDeviceLocale() {
        let ambiguous = ["03/09/2026", "01/04/2026", "05/06/2026"]
        XCTAssertEqual(ImportValue.slashOrder(in: ambiguous, locale: us), .monthFirst)
        XCTAssertEqual(ImportValue.slashOrder(in: ambiguous, locale: gb), .dayFirst)
    }

    func test_aColumnCarryingBothStaysMonthFirst() {
        // 13/04 and 04/13 in one column is broken whichever way it is read.
        // Month-first is the old behaviour, so this cannot make an existing
        // import worse than it already was.
        XCTAssertEqual(
            ImportValue.slashOrder(in: ["13/04/2026", "04/13/2026"], locale: gb),
            .monthFirst
        )
    }

    func test_isoDatesSettleNothingAndAreUnaffected() {
        XCTAssertNil(ImportValue.slashParts("2026-09-03"))
        XCTAssertEqual(ImportValue.dateISO("2026-09-03", order: .dayFirst), "2026-09-03")
        XCTAssertEqual(ImportValue.dateISO("2026-09-03", order: .monthFirst), "2026-09-03")
    }

    // MARK: - Parsing with the resolved order

    func test_theSameStringParsesToTheDayTheSellerMeant() {
        XCTAssertEqual(ImportValue.dateISO("03/09/2026", order: .dayFirst), "2026-09-03")
        XCTAssertEqual(ImportValue.dateISO("03/09/2026", order: .monthFirst), "2026-03-09")
    }

    // MARK: - End to end through the mapper

    func test_aBritishSheetImportsTheDatesItMeant() throws {
        let sheet = CSVParser.parseSheet(
            """
            Title,Bought
            Barbour jacket,03/09/2026
            Levi 501,13/04/2026
            """
        )
        let mapping: [ImportField] = [.title, .purchaseDate]
        let rows = ImportMapping.mapAll(sheet: sheet, mapping: mapping, locale: us)
        guard case let .ready(first)? = rows.first else {
            return XCTFail("row should be importable")
        }
        XCTAssertEqual(
            first.acquiredDate, "2026-09-03",
            "row 2 is ambiguous on its own; row 3's 13 proves the column is day-first"
        )
    }

    func test_theNoticeSaysWhichReadingWasUsedAndWhy() throws {
        let mapping: [ImportField] = [.title, .purchaseDate]
        let proven = CSVParser.parseSheet("Title,Bought\nA,13/04/2026")
        let provenNotice = try XCTUnwrap(
            ImportMapping.dateOrderNotice(sheet: proven, mapping: mapping, locale: us)
        )
        XCTAssertTrue(provenNotice.contains("day/month/year"))
        XCTAssertTrue(provenNotice.contains("2026-04-13"), "it shows the result, not just the rule")
        XCTAssertFalse(provenNotice.contains("for your region"), "the column settled it")

        let ambiguous = CSVParser.parseSheet("Title,Bought\nA,03/09/2026")
        let guessNotice = try XCTUnwrap(
            ImportMapping.dateOrderNotice(sheet: ambiguous, mapping: mapping, locale: gb)
        )
        XCTAssertTrue(guessNotice.contains("for your region"), "nothing settled it, so say so")
        XCTAssertTrue(guessNotice.contains("day/month/year"))
    }

    func test_thereIsNoNoticeWithoutASlashedDateColumn() {
        let mapping: [ImportField] = [.title, .purchaseDate]
        let iso = CSVParser.parseSheet("Title,Bought\nA,2026-09-03")
        XCTAssertNil(ImportMapping.dateOrderNotice(sheet: iso, mapping: mapping, locale: gb))
        let none = CSVParser.parseSheet("Title,Brand\nA,Nike")
        XCTAssertNil(ImportMapping.dateOrderNotice(sheet: none, mapping: [.title, .brand]))
    }
}
