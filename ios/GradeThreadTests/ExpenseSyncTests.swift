import XCTest
@testable import GradeThread

/// US-750: expenses now sync into the shared SwiftData cache via the same
/// resilient wire-decode path as sales. These cover the `RemoteExpenseRow`
/// contract: lenient amount, optional 00266 attribution links, date-only
/// `spent_on` parsing, and that one bad row never blanks the whole pull.
final class ExpenseSyncTests: XCTestCase {

    func test_decodesExpenseRow_numericAmount_withLinks() throws {
        let json = #"""
        {"id":"e1","category":"shipping_supplies","description":"Boxes",
         "amount":24.50,"spent_on":"2026-05-28",
         "inventory_item_id":"item-1","listing_id":"lst-9",
         "created_at":"2026-05-28T10:00:00Z"}
        """#
        let row = try JSONDecoder().decode(SyncEngine.RemoteExpenseRow.self, from: Data(json.utf8))
        XCTAssertEqual(row.amount, 24.5, accuracy: 0.001)
        XCTAssertEqual(row.category, "shipping_supplies")
        XCTAssertEqual(row.description, "Boxes")
        XCTAssertEqual(row.inventory_item_id, "item-1")
        XCTAssertEqual(row.listing_id, "lst-9")
    }

    func test_decodesExpenseRow_stringAmount_nullLinks_dateOnlyParse() throws {
        // Decimal-as-string + absent attribution links (general overhead).
        let json = #"""
        {"id":"e2","category":"storage","amount":"9.99","spent_on":"2026-05-01",
         "created_at":"2026-05-01T00:00:00Z"}
        """#
        let row = try JSONDecoder().decode(SyncEngine.RemoteExpenseRow.self, from: Data(json.utf8))
        XCTAssertEqual(row.amount, 9.99, accuracy: 0.001)
        XCTAssertNil(row.inventory_item_id)
        XCTAssertNil(row.listing_id)

        // `spent_on` is a date-only column; spentOnDate must parse it (not fall
        // back to .now / .distantPast).
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let parts = cal.dateComponents([.year, .month, .day], from: row.spentOnDate)
        XCTAssertEqual(parts.year, 2026)
        XCTAssertEqual(parts.month, 5)
        XCTAssertEqual(parts.day, 1)
    }

    func test_resilientDecode_dropsBadRows() {
        // Second row is missing the required `id` → dropped, first survives.
        let json = #"""
        [
          {"id":"a","category":"mileage","amount":5,"spent_on":"2026-05-01","created_at":"2026-05-01T00:00:00Z"},
          {"category":"storage","amount":7,"spent_on":"2026-05-02","created_at":"2026-05-02T00:00:00Z"}
        ]
        """#
        let rows = SyncEngine.decodeExpensesResiliently(Data(json.utf8))
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.id, "a")
    }
}
