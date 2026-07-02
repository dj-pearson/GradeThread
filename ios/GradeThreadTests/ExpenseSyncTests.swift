import XCTest
import SwiftData
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

    // MARK: - US-1494: offline-create id preservation (no duplicate)

    @MainActor
    private func inMemoryContext() throws -> ModelContext {
        let schema = Schema([LocalPendingMutation.self])
        let config = ModelConfiguration(
            schema: schema, isStoredInMemoryOnly: true, cloudKitDatabase: .none
        )
        return ModelContext(try ModelContainer(for: schema, configurations: config))
    }

    @MainActor
    func test_enqueueCreate_preservesPayloadClientId_noDuplicate() throws {
        let ctx = try inMemoryContext()
        struct ExpensePayload: Encodable { let id: String; let amount: Double }
        let clientId = "abc-1234-lower"

        let returned = OfflineMutationQueue.enqueueCreate(
            kind: .createExpense,
            payload: ExpensePayload(id: clientId, amount: 5),
            id: clientId,
            in: ctx
        )
        // Returned + persisted targetId + payload id must all stay the client id —
        // otherwise the replayed server row's id differs from the local mirror and
        // a DUPLICATE expense appears (the US-1494 bug).
        XCTAssertEqual(returned, clientId)
        let muts = try ctx.fetch(FetchDescriptor<LocalPendingMutation>())
        XCTAssertEqual(muts.count, 1)
        XCTAssertEqual(muts.first?.targetId, clientId)
        let dict = try JSONSerialization.jsonObject(with: muts.first!.payload) as? [String: Any]
        XCTAssertEqual(dict?["id"] as? String, clientId)
    }

    @MainActor
    func test_enqueueCreate_defaultId_isLowercased() throws {
        let ctx = try inMemoryContext()
        struct NoId: Encodable { let amount: Double }
        let returned = OfflineMutationQueue.enqueueCreate(
            kind: .createExpense, payload: NoId(amount: 1), in: ctx
        )
        XCTAssertNotNil(returned)
        XCTAssertEqual(returned, returned?.lowercased())
    }
}
