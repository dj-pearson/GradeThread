import XCTest
@testable import GradeThread

/// A CSV cell that the mapper reads and cannot coerce imports as blank, and the
/// row still counts as ready. Nothing anywhere says it happened.
///
/// The status column is the expensive one. `ImportValue.status` knows "sold"
/// and not "sold out", so a spreadsheet that says "Sold Out" imports every one
/// of those items as `cataloged`: sold stock lands back in unsold inventory,
/// counted in the seller's equity and their aging report.
final class ImportDroppedCellTests: XCTestCase {

    private func sheet(_ csv: String) -> CSVParser.Sheet {
        CSVParser.parseSheet(csv)
    }

    private let mapping: [ImportField] = [
        .title, .status, .category, .purchasePrice, .purchaseDate,
    ]

    func test_aStatusTheTableDoesNotKnowIsReportedRatherThanDefaulted() {
        let s = sheet(
            """
            Title,Status,Category,Cost,Bought
            Levi 501,Sold Out,Clothing,20.00,2026-01-04
            """
        )
        let dropped = ImportMapping.droppedCells(sheet: s, mapping: mapping)
        XCTAssertEqual(dropped.count, 1)
        XCTAssertEqual(dropped.first?.field, .status)
        XCTAssertEqual(dropped.first?.raw, "Sold Out")
        XCTAssertEqual(dropped.first?.row, 2, "header is row 1, so the first data row is 2")

        // And the row still imports, which is exactly why it needs reporting.
        let mapped = ImportMapping.mapAll(sheet: s, mapping: mapping)
        guard case let .ready(draft)? = mapped.first else {
            return XCTFail("the row should still be importable")
        }
        XCTAssertNil(draft.status, "the unreadable status became nothing")
    }

    func test_everyCoercingFieldIsChecked() {
        let s = sheet(
            """
            Title,Status,Category,Cost,Bought
            Jacket,In Progress,Women's Clothing,n/a,Sept 3 2026
            """
        )
        let fields = Set(ImportMapping.droppedCells(sheet: s, mapping: mapping).map(\.field))
        XCTAssertEqual(fields, [.status, .category, .purchasePrice, .purchaseDate])
    }

    func test_valuesTheMapperUnderstandsAreNotReported() {
        let s = sheet(
            """
            Title,Status,Category,Cost,Bought
            Levi 501,sold,Clothing,$20.00,2026-01-04
            Nike Tee,listed,Shoes,"1.299,00",01/04/2026
            """
        )
        XCTAssertEqual(ImportMapping.droppedCells(sheet: s, mapping: mapping), [])
    }

    func test_anEmptyCellIsNotADroppedCell() {
        // Blank means the seller had nothing to say. Only a cell with content
        // that reaches the database as nothing counts.
        let s = sheet(
            """
            Title,Status,Category,Cost,Bought
            Levi 501,,,,
            """
        )
        XCTAssertEqual(ImportMapping.droppedCells(sheet: s, mapping: mapping), [])
    }

    func test_aRowWithNoTitleIsNotDoubleReported() {
        // It is already surfaced as "Missing item title" and never inserted, so
        // naming its cells too is noise on a row that is not importing anyway.
        let s = sheet(
            """
            Title,Status,Category,Cost,Bought
            ,Sold Out,Nonsense,n/a,whenever
            """
        )
        XCTAssertEqual(ImportMapping.droppedCells(sheet: s, mapping: mapping), [])
    }

    func test_theSummaryNamesAFieldAndAnExample() throws {
        let s = sheet(
            """
            Title,Status,Category,Cost,Bought
            Levi 501,Sold Out,Clothing,20.00,2026-01-04
            """
        )
        let summary = try XCTUnwrap(
            ImportMapping.droppedSummary(ImportMapping.droppedCells(sheet: s, mapping: mapping))
        )
        XCTAssertTrue(summary.contains("Status"), "the field has to be named")
        XCTAssertTrue(summary.contains("Sold Out"), "and the value the seller typed")
        XCTAssertTrue(summary.contains("row 2"))
        XCTAssertTrue(summary.contains("1 cell"), "singular when there is one")
    }

    func test_thereIsNoSummaryWhenNothingWasDropped() {
        XCTAssertNil(ImportMapping.droppedSummary([]))
    }
}
