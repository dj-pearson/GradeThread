import XCTest
@testable import GradeThread

/// US-675 — AutoLister drafts library + bulk-edit: wire decode, the editable
/// row helpers, and both stores (library rollups + bulk-apply / save) via a
/// faked drafts service.
final class DraftsTests: XCTestCase {

    // MARK: - Fake

    final class FakeService: DraftsProviding {
        var drafts: [DraftListing]
        var titles: [String: String]
        var fetchError: Error?
        var saveError: Error?
        private(set) var saved: [DraftEdit] = []

        init(drafts: [DraftListing], titles: [String: String] = [:]) {
            self.drafts = drafts
            self.titles = titles
        }

        func fetchDrafts() async throws -> [DraftListing] {
            if let fetchError { throw fetchError }
            return drafts
        }
        func fetchItemTitles(ids: [String]) async throws -> [String: String] { titles }
        func save(_ edit: DraftEdit) async throws {
            if let saveError { throw saveError }
            saved.append(edit)
        }
    }

    private func draft(
        _ id: String, item: String = "i", batch: String? = "b1",
        title: String? = nil, price: Double? = 10, category: String? = nil
    ) -> DraftListing {
        DraftListing(
            id: id, inventoryItemId: item, listingTitle: title, listingPrice: price,
            platformCategoryId: category, batchId: batch
        )
    }

    // MARK: - Decode

    func test_decode_lenientPriceAndFields() throws {
        let json = """
        {"id":"l1","inventory_item_id":"i1","listing_title":"Coat",
         "listing_price":"19.99","platform_category_id":"57988","batch_id":"b1",
         "price_is_estimated":true}
        """.data(using: .utf8)!
        let d = try JSONDecoder().decode(DraftListing.self, from: json)
        XCTAssertEqual(d.listingPrice ?? 0, 19.99, accuracy: 0.001)  // numeric string
        XCTAssertEqual(d.platformCategoryId, "57988")
        XCTAssertEqual(d.priceIsEstimated, true)
    }

    // MARK: - Edit row helpers

    func test_priceString_cleanFormatting() {
        XCTAssertEqual(DraftEditRow.priceString(12), "12")
        XCTAssertEqual(DraftEditRow.priceString(12.5), "12.50")
        XCTAssertEqual(DraftEditRow.priceString(nil), "")
    }

    func test_toEdit_blanksBecomeNil() {
        var row = DraftEditRow(from: draft("l1", title: "x", price: 5, category: "11"))
        row.title = "   "
        row.condition = ""
        row.categoryId = ""
        let edit = row.toEdit()
        XCTAssertNil(edit.title)
        XCTAssertNil(edit.condition)
        XCTAssertNil(edit.categoryId)
        XCTAssertEqual(edit.quantity, 1)
    }

    func test_roundTo99() {
        XCTAssertEqual(DraftsBulkEditStore.roundTo99(12.34), 12.99, accuracy: 0.001)
        XCTAssertEqual(DraftsBulkEditStore.roundTo99(20), 20.99, accuracy: 0.001)
        XCTAssertEqual(DraftsBulkEditStore.roundTo99(0.75), 0.75, accuracy: 0.001)
    }

    // MARK: - Library store

    @MainActor
    func test_library_filtersOutBatchlessAndRollsUp() async {
        let fake = FakeService(drafts: [
            draft("a", price: 10, category: "1"),
            draft("b", price: 20, category: nil),
            draft("c", batch: nil, price: 99),     // manual draft — excluded
        ], titles: ["i": "Item"])
        let store = DraftsLibraryStore(service: fake)
        await store.load()
        XCTAssertEqual(store.phase, .ready)
        XCTAssertEqual(store.drafts.map(\.id).sorted(), ["a", "b"])
        XCTAssertEqual(store.totalValue, 30, accuracy: 0.001)
        XCTAssertEqual(store.batchCount, 1)
    }

    @MainActor
    func test_library_titleFallbackAndSearch() async {
        let fake = FakeService(drafts: [
            draft("a", item: "i1", title: "Red coat"),
            draft("b", item: "i2", title: nil),
        ], titles: ["i2": "Blue jeans"])
        let store = DraftsLibraryStore(service: fake)
        await store.load()
        XCTAssertEqual(store.title(for: store.drafts.first { $0.id == "b" }!), "Blue jeans")
        XCTAssertEqual(store.filtered(matching: "red").map(\.id), ["a"])
        XCTAssertEqual(store.filtered(matching: "jeans").map(\.id), ["b"])
    }

    // MARK: - Bulk-edit store

    @MainActor
    func test_bulk_scopesToBatch() async {
        let fake = FakeService(drafts: [
            draft("a", batch: "b1"), draft("b", batch: "b2"),
        ])
        let store = DraftsBulkEditStore(service: fake, batchId: "b1")
        await store.load()
        XCTAssertEqual(store.rows.map(\.id), ["a"])
    }

    @MainActor
    func test_bulk_markupAppliesToSelectionOnly() async {
        let fake = FakeService(drafts: [draft("a", price: 10), draft("b", price: 10)])
        let store = DraftsBulkEditStore(service: fake)
        await store.load()
        store.toggle("a")                 // select only a
        store.applyMarkup("10")
        XCTAssertEqual(store.rows.first { $0.id == "a" }?.price, "11.00")
        XCTAssertEqual(store.rows.first { $0.id == "b" }?.price, "10")  // untouched
        XCTAssertTrue(store.rows.first { $0.id == "a" }?.dirty ?? false)
    }

    @MainActor
    func test_bulk_noSelectionTargetsAllRows() async {
        let fake = FakeService(drafts: [draft("a", price: 10), draft("b", price: 20)])
        let store = DraftsBulkEditStore(service: fake)
        await store.load()
        store.applyRound99()              // no selection -> all
        XCTAssertEqual(store.rows.first { $0.id == "a" }?.price, "10.99")
        XCTAssertEqual(store.rows.first { $0.id == "b" }?.price, "20.99")
    }

    @MainActor
    func test_bulk_applyTemplateStampsConditionCategoryPolicies() async {
        let fake = FakeService(drafts: [draft("a")])
        let store = DraftsBulkEditStore(service: fake)
        await store.load()
        let t = ListingTemplate(
            id: "t", name: "T", ebayCondition: "USED_GOOD",
            ebayCategoryId: "57988", returnPolicyId: "rp",
            shippingPolicyId: "sp", paymentPolicyId: "pp"
        )
        store.applyTemplate(t)
        let row = store.rows[0]
        XCTAssertEqual(row.condition, "USED_GOOD")
        XCTAssertEqual(row.categoryId, "57988")
        XCTAssertEqual(row.shippingPolicyId, "sp")
        XCTAssertTrue(row.dirty)
    }

    @MainActor
    func test_bulk_saveOnlyDirtyRowsThenMarksClean() async {
        let fake = FakeService(drafts: [draft("a", price: 10), draft("b", price: 10)])
        let store = DraftsBulkEditStore(service: fake)
        await store.load()
        store.update("a") { $0.price = "12" }   // only a dirty
        await store.save()
        XCTAssertEqual(fake.saved.map(\.id), ["a"])
        XCTAssertEqual(store.lastSavedCount, 1)
        XCTAssertEqual(store.dirtyCount, 0)
    }

    @MainActor
    func test_bulk_saveFailureSurfacesErrorAndReloads() async {
        let fake = FakeService(drafts: [draft("a", price: 10)])
        fake.saveError = EdgeAPIError.rateLimited
        let store = DraftsBulkEditStore(service: fake)
        await store.load()
        store.update("a") { $0.price = "12" }
        await store.save()
        XCTAssertNotNil(store.actionError)
        XCTAssertTrue(fake.saved.isEmpty)
        // reload restored server truth (price back to "10", clean)
        XCTAssertEqual(store.rows.first?.price, "10")
        XCTAssertEqual(store.dirtyCount, 0)
    }
}
