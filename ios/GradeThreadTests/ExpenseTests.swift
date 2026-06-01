import XCTest
@testable import GradeThread

@MainActor
final class ExpenseTests: XCTestCase {

    // MARK: - Decoding

    func test_decodesExpense_numericAmount() throws {
        let json = #"""
        {"id":"e1","category":"shipping_supplies","description":"Boxes",
         "amount":24.50,"spent_on":"2026-05-28"}
        """#
        let e = try JSONDecoder().decode(RemoteExpense.self, from: Data(json.utf8))
        XCTAssertEqual(e.amount, 24.5, accuracy: 0.001)
        XCTAssertEqual(e.categoryValue, .shippingSupplies)
        XCTAssertEqual(e.description, "Boxes")
        XCTAssertNotEqual(e.date, .distantPast)
    }

    func test_decodesExpense_stringAmountAndUnknownCategory() throws {
        // Decimal-as-string + a category the app doesn't know → falls back.
        let json = #"""
        {"id":"e2","category":"weird_new_thing","amount":"9.99","spent_on":"2026-05-01"}
        """#
        let e = try JSONDecoder().decode(RemoteExpense.self, from: Data(json.utf8))
        XCTAssertEqual(e.amount, 9.99, accuracy: 0.001)
        XCTAssertEqual(e.categoryValue, .other)
        XCTAssertNil(e.description)
    }

    func test_resilientDecode_dropsBadRows() {
        let json = #"""
        [
          {"id":"a","category":"mileage","amount":5,"spent_on":"2026-05-01"},
          {"category":"storage","amount":7,"spent_on":"2026-05-02"}
        ]
        """#
        let rows = ExpenseStore.decodeResiliently(Data(json.utf8))
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.id, "a")
    }

    // MARK: - thisMonthTotal

    func test_thisMonthTotal_sumsOnlyCurrentMonth() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let now = Date(timeIntervalSince1970: 1_700_000_000) // 2023-11-14

        let store = ExpenseStore()
        store.phase = .ready([
            RemoteExpense(id: "1", category: "mileage", description: nil, amount: 10, spentOn: "2023-11-03"),
            RemoteExpense(id: "2", category: "storage", description: nil, amount: 15, spentOn: "2023-11-20"),
            RemoteExpense(id: "3", category: "other", description: nil, amount: 99, spentOn: "2023-10-15"),
        ])
        XCTAssertEqual(store.thisMonthTotal(now: now, calendar: cal), 25, accuracy: 0.001)
    }
}
