import XCTest
@testable import GradeThread

/// US-669 — shipping & fulfillment queue. The data layer is faked so the store
/// logic (load / filter-unshipped / oldest-first / optimistic mark-shipped /
/// error surfacing) and the lenient decode are exercised without a network.
final class FulfillmentTests: XCTestCase {

    // MARK: - Fake

    final class FakeService: FulfillmentProviding {
        var orders: [FulfillmentOrder]
        var fetchError: Error?
        var markError: Error?
        private(set) var marked: [(saleId: String, tracking: String?)] = []

        init(orders: [FulfillmentOrder]) { self.orders = orders }

        func fetchOrders() async throws -> [FulfillmentOrder] {
            if let fetchError { throw fetchError }
            return orders
        }

        func markShipped(saleId: String, trackingNumber: String?, shippedAt: Date) async throws {
            if let markError { throw markError }
            marked.append((saleId, trackingNumber))
            orders.removeAll { $0.id == saleId }
        }
    }

    private func order(
        _ id: String,
        soldAt: String? = nil,
        saleDate: String = "2024-01-01",
        shippedAt: String? = nil,
        label: Double = 0
    ) -> FulfillmentOrder {
        FulfillmentOrder(
            id: id,
            salePrice: 50,
            shippingCost: label,
            buyerUsername: "buyer_\(id)",
            itemTitle: "Item \(id)",
            soldAtRaw: soldAt,
            saleDateRaw: saleDate,
            shippedAtRaw: shippedAt
        )
    }

    // MARK: - Decode

    func test_decode_lenientAmountsAndEmbeddedTitle() throws {
        let json = """
        [
          {"id":"s1","sale_price":59.99,"shipping_cost":"4.50","sale_date":"2024-01-03",
           "sold_at":"2024-01-03T10:00:00Z","shipped_at":null,"tracking_number":null,
           "buyer_username":"jane","inventory_items":{"title":"Wool coat"}}
        ]
        """.data(using: .utf8)!
        let rows = FulfillmentStore.decodeOrdersResiliently(json)
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].salePrice, 59.99, accuracy: 0.001)
        XCTAssertEqual(rows[0].shippingCost, 4.50, accuracy: 0.001)  // numeric string parsed
        XCTAssertEqual(rows[0].itemTitle, "Wool coat")
        XCTAssertFalse(rows[0].isShipped)
    }

    func test_decode_shippedRowFlagsIsShipped() throws {
        let json = """
        [{"id":"s2","sale_price":10,"shipping_cost":0,"sale_date":"2024-01-01",
          "shipped_at":"2024-01-05T12:00:00Z"}]
        """.data(using: .utf8)!
        let rows = FulfillmentStore.decodeOrdersResiliently(json)
        XCTAssertEqual(rows.count, 1)
        XCTAssertTrue(rows[0].isShipped)
    }

    func test_decode_oneBadRowDoesNotAbortArray() {
        let json = """
        [{"id":"ok","sale_price":5,"shipping_cost":0,"sale_date":"2024-01-01"},
         {"sale_price":5}]
        """.data(using: .utf8)!  // second row missing required `id`
        let rows = FulfillmentStore.decodeOrdersResiliently(json)
        XCTAssertEqual(rows.map(\.id), ["ok"])
    }

    // MARK: - Load / filter / sort

    @MainActor
    func test_load_filtersShippedAndSortsOldestFirst() async {
        let fake = FakeService(orders: [
            order("new", saleDate: "2024-03-01"),
            order("done", saleDate: "2024-02-01", shippedAt: "2024-02-02T00:00:00Z"),
            order("old", saleDate: "2024-01-01"),
        ])
        let store = FulfillmentStore(service: fake)
        await store.load()
        XCTAssertEqual(store.phase, .ready)
        // Shipped row excluded; remaining sorted oldest sold first.
        XCTAssertEqual(store.orders.map(\.id), ["old", "new"])
        XCTAssertEqual(store.needsShippingCount, 2)
    }

    @MainActor
    func test_load_failureSurfacesMessage() async {
        let fake = FakeService(orders: [])
        fake.fetchError = EdgeAPIError.badRequest(detail: "boom")
        let store = FulfillmentStore(service: fake)
        await store.load()
        if case .failed = store.phase { } else { XCTFail("expected failed phase") }
    }

    @MainActor
    func test_totalLabelCost_sumsQueue() async {
        let fake = FakeService(orders: [
            order("a", label: 4.50),
            order("b", label: 5.25),
        ])
        let store = FulfillmentStore(service: fake)
        await store.load()
        XCTAssertEqual(store.totalLabelCost, 9.75, accuracy: 0.001)
    }

    // MARK: - Mark shipped

    @MainActor
    func test_markShipped_optimisticallyRemovesAndRecordsTracking() async {
        let fake = FakeService(orders: [order("s1"), order("s2")])
        let store = FulfillmentStore(service: fake)
        await store.load()
        await store.markShipped(store.orders[0], trackingNumber: "  1Z999  ")
        XCTAssertEqual(store.orders.count, 1)
        XCTAssertEqual(fake.marked.first?.saleId, "s1")
        XCTAssertEqual(fake.marked.first?.tracking, "1Z999")  // trimmed
        XCTAssertNil(store.actionError)
    }

    @MainActor
    func test_markShipped_emptyTrackingPassesNil() async {
        let fake = FakeService(orders: [order("s1")])
        let store = FulfillmentStore(service: fake)
        await store.load()
        await store.markShipped(store.orders[0], trackingNumber: "   ")
        XCTAssertNil(fake.marked.first?.tracking ?? nil)
    }

    @MainActor
    func test_markShipped_failureRestoresRowAndSurfacesError() async {
        let fake = FakeService(orders: [order("s1")])
        fake.markError = EdgeAPIError.badRequest(detail: "nope")
        let store = FulfillmentStore(service: fake)
        await store.load()
        await store.markShipped(store.orders[0], trackingNumber: nil)
        // Optimistic removal undone by the reload (fake still has the row).
        XCTAssertEqual(store.orders.map(\.id), ["s1"])
        XCTAssertNotNil(store.actionError)
    }
}
