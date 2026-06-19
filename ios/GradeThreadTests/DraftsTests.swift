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

    // MARK: - Provenance (US-1086)

    @MainActor
    func test_bulk_skipsEbayOriginatedRowsOnSave() async {
        let gtDraft = DraftListing(id: "l1", inventoryItemId: "i1", batchId: "b1")
        let ebayDraft = DraftListing(
            id: "l2", inventoryItemId: "i2", batchId: "b1", listingOrigin: "ebay"
        )
        let fake = FakeService(drafts: [gtDraft, ebayDraft])
        let store = DraftsBulkEditStore(service: fake)
        await store.load()
        store.update("l1") { $0.title = "GT edit" }
        store.update("l2") { $0.title = "eBay edit (should be discarded)" }
        await store.save()
        // Only the GradeThread-originated row is persisted; eBay row is silently skipped.
        XCTAssertEqual(fake.saved.map(\.id), ["l1"])
        XCTAssertEqual(store.lastSavedCount, 1)
        XCTAssertNil(store.actionError)
    }

    func test_editRow_isEbayOriginated_trueFalse() {
        let gt = DraftEditRow(from: DraftListing(id: "a", inventoryItemId: "i", listingOrigin: "gradethread"))
        let eb = DraftEditRow(from: DraftListing(id: "b", inventoryItemId: "i", listingOrigin: "ebay"))
        let unknown = DraftEditRow(from: DraftListing(id: "c", inventoryItemId: "i"))
        XCTAssertFalse(gt.isEbayOriginated)
        XCTAssertTrue(eb.isEbayOriginated)
        XCTAssertFalse(unknown.isEbayOriginated)
    }

    func test_toEdit_carriesListingOrigin() {
        let row = DraftEditRow(from: DraftListing(
            id: "x", inventoryItemId: "i", listingOrigin: "gradethread"
        ))
        XCTAssertEqual(row.toEdit().listingOrigin, "gradethread")
    }

    // MARK: - Library bulk-publish (US-964)

    /// Fakes the validate→push surface so the publish loop is testable without
    /// live HTTP. Keyed by inventory item id; defaults to success.
    @MainActor
    final class FakePublisher: DraftPublishing {
        var validateOutcomes: [String: PublishOutcome] = [:]
        var pushOutcomes: [String: PublishOutcome] = [:]
        private(set) var validated: [String] = []
        private(set) var pushed: [String] = []

        func validate(inventoryItemId: String) async -> PublishOutcome {
            validated.append(inventoryItemId)
            return validateOutcomes[inventoryItemId]
                ?? .validated(ValidateResponse(ok: true, blockers: [], summary: nil))
        }

        func push(inventoryItemId: String, relist: Bool) async -> PublishOutcome {
            pushed.append(inventoryItemId)
            return pushOutcomes[inventoryItemId]
                ?? .pushed(PushResponse(
                    ok: true, listingId: "L", listingURL: "u", offerId: "o", sku: "s"
                ))
        }
    }

    private func ready(_ id: String, item: String) -> DraftListing {
        DraftListing(
            id: id, inventoryItemId: item, listingTitle: "Coat", listingPrice: 10,
            ebayCondition: "USED_GOOD", platformCategoryId: "57988", batchId: "b1"
        )
    }

    @MainActor
    func test_library_publishSelected_publishesReadySkipsBlocked() async {
        // a = ready (title/price/condition/category); b = blocked (no category).
        let blocked = DraftListing(
            id: "b", inventoryItemId: "i2", listingTitle: "Hat", listingPrice: 5,
            ebayCondition: "USED_GOOD", platformCategoryId: nil, batchId: "b1"
        )
        let fake = FakeService(drafts: [ready("a", item: "i1"), blocked],
                               titles: ["i1": "Coat", "i2": "Hat"])
        let store = DraftsLibraryStore(service: fake)
        await store.load()
        store.toggle("a")
        store.toggle("b")

        let publisher = FakePublisher()
        let published = await store.publishSelected(using: publisher)

        XCTAssertEqual(published, ["a"])
        // Only the ready draft reached the network; the blocked one is gated locally.
        XCTAssertEqual(publisher.validated, ["i1"])
        XCTAssertEqual(publisher.pushed, ["i1"])
        XCTAssertEqual(store.publishSummary, "Published 1 of 2; 1 skipped:\nHat: No category")
        // Published draft is deselected; the skipped one stays selected for retry.
        XCTAssertEqual(store.selected, ["b"])
    }

    @MainActor
    func test_library_publishSelected_allReadyReportsSuccessAndReturnsIds() async {
        let fake = FakeService(drafts: [ready("a", item: "i1"), ready("c", item: "i3")])
        let store = DraftsLibraryStore(service: fake)
        await store.load()
        store.toggle("a")
        store.toggle("c")

        let published = await store.publishSelected(using: FakePublisher())

        XCTAssertEqual(published, ["a", "c"])
        XCTAssertEqual(store.publishSummary, "Published 2 drafts to eBay.")
    }

    @MainActor
    func test_library_publishSelected_pushFailureSurfacesPerItemReason() async {
        let fake = FakeService(drafts: [ready("a", item: "i1")], titles: ["i1": "Coat"])
        let store = DraftsLibraryStore(service: fake)
        await store.load()
        store.toggle("a")

        let publisher = FakePublisher()
        publisher.pushOutcomes["i1"] = .noOfferId
        let published = await store.publishSelected(using: publisher)

        XCTAssertTrue(published.isEmpty)
        XCTAssertEqual(store.publishSummary,
                       "Published 0 of 1; 1 skipped:\nCoat: no eBay offer — sync first")
    }

    @MainActor
    func test_library_publishSelected_noSelectionIsNoOp() async {
        let fake = FakeService(drafts: [ready("a", item: "i1")])
        let store = DraftsLibraryStore(service: fake)
        await store.load()

        let publisher = FakePublisher()
        let published = await store.publishSelected(using: publisher)

        XCTAssertTrue(published.isEmpty)
        XCTAssertTrue(publisher.validated.isEmpty)
        XCTAssertNil(store.publishSummary)
    }

    @MainActor
    func test_library_publishSelected_skipsEbayOriginated() async {
        let ebay = DraftListing(
            id: "e", inventoryItemId: "i9", listingTitle: "Jacket", listingPrice: 20,
            ebayCondition: "USED_GOOD", platformCategoryId: "1", batchId: "b1",
            listingOrigin: "ebay"
        )
        let fake = FakeService(drafts: [ebay], titles: ["i9": "Jacket"])
        let store = DraftsLibraryStore(service: fake)
        await store.load()
        store.toggle("e")

        let publisher = FakePublisher()
        let published = await store.publishSelected(using: publisher)

        XCTAssertTrue(published.isEmpty)
        XCTAssertTrue(publisher.pushed.isEmpty)
        XCTAssertEqual(store.publishSummary,
                       "Published 0 of 1; 1 skipped:\nJacket: eBay-originated — edit on eBay")
    }
}
