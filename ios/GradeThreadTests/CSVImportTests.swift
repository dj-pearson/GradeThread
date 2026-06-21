import XCTest
@testable import GradeThread

/// US-667 — CSV parsing, header→field guessing, value normalization, row
/// mapping, and the import store's preview/commit gating. All pure logic +
/// a faked Sheets fetch, so no network or ModelContainer is needed.
final class CSVImportTests: XCTestCase {

    // MARK: - Parser

    func test_parser_quotedFieldsAndEmbeddedNewlines() {
        let csv = "title,notes\n\"Nike Tee\",\"line1\nline2\"\n\"a,b\",\"he said \"\"hi\"\"\""
        let sheet = CSVParser.parseSheet(csv)
        XCTAssertEqual(sheet.headers, ["title", "notes"])
        XCTAssertEqual(sheet.rows.count, 2)
        XCTAssertEqual(sheet.rows[0], ["Nike Tee", "line1\nline2"])
        XCTAssertEqual(sheet.rows[1], ["a,b", "he said \"hi\""])
    }

    func test_parser_detectsTabDelimiter() {
        let tsv = "title\tbrand\nTee\tNike"
        XCTAssertEqual(CSVParser.detectDelimiter(tsv), .tab)
        let sheet = CSVParser.parseSheet(tsv)
        XCTAssertEqual(sheet.headers, ["title", "brand"])
        XCTAssertEqual(sheet.rows[0], ["Tee", "Nike"])
    }

    func test_parser_padsShortRowsToHeaderWidth() {
        let csv = "a,b,c\n1,2\n1,2,3,4"
        let sheet = CSVParser.parseSheet(csv)
        XCTAssertEqual(sheet.rows[0], ["1", "2", ""])      // padded
        XCTAssertEqual(sheet.rows[1], ["1", "2", "3"])     // truncated
    }

    func test_parser_dropsTrailingBlankRows() {
        let sheet = CSVParser.parseSheet("a,b\n1,2\n\n\n")
        XCTAssertEqual(sheet.rows.count, 1)
    }

    // MARK: - Field guessing

    func test_guessField_commonHeaders() {
        XCTAssertEqual(ImportField.guess(from: "Item Title"), .title)
        XCTAssertEqual(ImportField.guess(from: "SKU"), .sku)
        XCTAssertEqual(ImportField.guess(from: "Item #"), .sku)
        XCTAssertEqual(ImportField.guess(from: "Cost"), .purchasePrice)
        XCTAssertEqual(ImportField.guess(from: "List Price"), .listPrice)
        XCTAssertEqual(ImportField.guess(from: "Colour"), .color)
        XCTAssertEqual(ImportField.guess(from: "wat?"), .skip)
    }

    // MARK: - Value parsing

    func test_price_handlesSymbolsCommasAndParens() {
        XCTAssertEqual(ImportValue.price("$19.99"), 19.99)
        XCTAssertEqual(ImportValue.price("1,299"), 1299)
        XCTAssertEqual(ImportValue.price("(5.00)"), -5.0)
        XCTAssertNil(ImportValue.price("n/a"))
        XCTAssertNil(ImportValue.price(nil))
    }

    // US-1162: a CSV can be in a comma-decimal locale; the right-most separator
    // is the decimal, the other is grouping. The old filter corrupted these.
    func test_price_localeAwareDecimalAndGrouping() {
        XCTAssertEqual(ImportValue.price("1.299,00"), 1299.00) // EU: dot grouping, comma decimal
        XCTAssertEqual(ImportValue.price("5,00"), 5.00)        // EU decimal comma
        XCTAssertEqual(ImportValue.price("1,000,000"), 1_000_000) // US grouping only
        XCTAssertEqual(ImportValue.price("€1.234,56"), 1234.56)
    }

    func test_status_normalization() {
        XCTAssertEqual(ImportValue.status("Active"), "listed")
        XCTAssertEqual(ImportValue.status("SOLD"), "sold")
        XCTAssertEqual(ImportValue.status("draft"), "drafted")
        XCTAssertNil(ImportValue.status("whatever"))
    }

    func test_category_normalization() {
        XCTAssertEqual(ImportValue.category("Apparel"), "clothing")
        XCTAssertEqual(ImportValue.category("Sneakers"), "shoes")
        XCTAssertEqual(ImportValue.category("sports cards"), "sports_cards")
        XCTAssertNil(ImportValue.category("gizmos2"))
    }

    func test_dateISO_parsesCommonFormats() {
        XCTAssertEqual(ImportValue.dateISO("2024-03-05"), "2024-03-05")
        XCTAssertEqual(ImportValue.dateISO("3/5/2024"), "2024-03-05")
        XCTAssertNil(ImportValue.dateISO("not a date"))
    }

    // MARK: - Mapping

    func test_mapRow_buildsDraftAndFlagsMissingTitle() {
        let mapping: [ImportField] = [.title, .brand, .purchasePrice]
        let ok = ImportMapping.mapRow(["Nike Tee", "Nike", "$12"], mapping: mapping, rowNumber: 2)
        guard case let .ready(draft) = ok else { return XCTFail("expected ready") }
        XCTAssertEqual(draft.title, "Nike Tee")
        XCTAssertEqual(draft.brand, "Nike")
        XCTAssertEqual(draft.acquiredPrice, 12)

        let missing = ImportMapping.mapRow(["", "Nike", "$12"], mapping: mapping, rowNumber: 3)
        XCTAssertEqual(missing, .invalid(row: 3, reason: "Missing item title"))
    }

    func test_mapAll_dropsEmptyRowsKeepsErrors() {
        let sheet = CSVParser.parseSheet("title,brand\nTee,Nike\n,Adidas\n")
        let results = ImportMapping.mapAll(sheet: sheet, mapping: [.title, .brand])
        // 1 ready + 1 invalid (data but no title); the trailing blank is dropped.
        XCTAssertEqual(results.count, 2)
        XCTAssertEqual(results.filter { if case .ready = $0 { return true } else { return false } }.count, 1)
    }

    // MARK: - Store

    final class FakeSheets: SheetsImporting {
        var csv = "title,sku\nTee,A1"
        func fetchCSV(url: String) async throws -> String { csv }
    }

    @MainActor
    func test_store_loadCSV_guessesMappingAndPreviews() {
        let store = ImportStore(sheets: FakeSheets())
        store.loadCSV("Item Title,SKU,Cost\nNike Tee,A1,$10\n,B2,$5")
        XCTAssertEqual(store.phase, .mapping)
        XCTAssertEqual(store.mapping, [.title, .sku, .purchasePrice])
        XCTAssertTrue(store.hasTitleMapping)
        XCTAssertEqual(store.readyCount, 1)
        XCTAssertEqual(store.errorCount, 1)      // the no-title row
        XCTAssertTrue(store.canCommit)
    }

    @MainActor
    func test_store_loadCSV_emptyShowsBanner() {
        let store = ImportStore(sheets: FakeSheets())
        store.loadCSV("")
        XCTAssertEqual(store.phase, .source)
        XCTAssertNotNil(store.errorBanner)
    }

    @MainActor
    func test_store_cannotCommitWithoutTitleMapping() {
        let store = ImportStore(sheets: FakeSheets())
        store.loadCSV("foo,bar\n1,2")
        store.mapping = [.skip, .skip]
        XCTAssertFalse(store.hasTitleMapping)
        XCTAssertFalse(store.canCommit)
    }

    @MainActor
    func test_store_loadFromSheet_usesFetchedCSV() async {
        let fake = FakeSheets()
        fake.csv = "title,brand\nJacket,Levi"
        let store = ImportStore(sheets: fake)
        await store.loadFromSheet(url: "https://docs.google.com/spreadsheets/d/abc/edit")
        XCTAssertEqual(store.phase, .mapping)
        XCTAssertEqual(store.readyCount, 1)
    }
}
