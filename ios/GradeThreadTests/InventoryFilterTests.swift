import XCTest
import SwiftData
@testable import GradeThread

@MainActor
final class InventoryFilterTests: XCTestCase {

    // MARK: - InventoryStage

    func test_stage_toList_matchesPreDraftStatuses() {
        let statuses = InventoryStage.toList.matchingStatuses
        XCTAssertTrue(statuses.contains("cataloged"))
        XCTAssertTrue(statuses.contains("graded"))
        XCTAssertTrue(statuses.contains("comped"))
        XCTAssertFalse(statuses.contains("drafted"))
        XCTAssertFalse(statuses.contains("listed"))
    }

    func test_stage_drafts_active_sold_shipped_returned_exclusive() {
        XCTAssertEqual(InventoryStage.drafts.matchingStatuses, ["drafted"])
        XCTAssertEqual(InventoryStage.active.matchingStatuses, ["listed"])
        XCTAssertEqual(InventoryStage.sold.matchingStatuses, ["sold"])
        XCTAssertEqual(InventoryStage.shipped.matchingStatuses, ["shipped", "completed"])
        XCTAssertEqual(InventoryStage.returned.matchingStatuses, ["returned"])
    }

    func test_stage_all_includesEveryKnownStatus() {
        let all = InventoryStage.all.matchingStatuses
        for status in InventoryStage.allKnownStatuses {
            XCTAssertTrue(all.contains(status), "all should contain \(status)")
        }
    }

    // MARK: - SortOption.naturalCompare

    func test_naturalCompare_sortsNumericRunsByValue() {
        XCTAssertEqual(SortOption.naturalCompare("S-2", "S-10"), .orderedAscending)
        XCTAssertEqual(SortOption.naturalCompare("S-10", "S-2"), .orderedDescending)
        XCTAssertEqual(SortOption.naturalCompare("S-2", "S-2"), .orderedSame)
    }

    func test_naturalCompare_isCaseInsensitive() {
        XCTAssertEqual(SortOption.naturalCompare("abc", "ABC"), .orderedSame)
        XCTAssertEqual(SortOption.naturalCompare("ABC", "abd"), .orderedAscending)
    }

    func test_naturalCompare_emptyStrings() {
        XCTAssertEqual(SortOption.naturalCompare("", ""), .orderedSame)
        XCTAssertEqual(SortOption.naturalCompare("", "A"), .orderedAscending)
    }

    // MARK: - SortOption.isOrdered

    func test_sort_newest_putsRecentFirst() throws {
        let container = try makeContainer()
        let context = ModelContext(container)
        let older = LocalInventoryItem(
            id: "a", userId: "u", title: "Old", status: "cataloged",
            createdAt: Date(timeIntervalSince1970: 100),
            updatedAt: Date(timeIntervalSince1970: 100)
        )
        let newer = LocalInventoryItem(
            id: "b", userId: "u", title: "New", status: "cataloged",
            createdAt: Date(timeIntervalSince1970: 200),
            updatedAt: Date(timeIntervalSince1970: 200)
        )
        context.insert(older)
        context.insert(newer)

        XCTAssertTrue(SortOption.newest.isOrdered(newer, older))
        XCTAssertFalse(SortOption.newest.isOrdered(older, newer))
    }

    func test_sort_bestROI_handlesMissingValues() throws {
        let container = try makeContainer()
        let context = ModelContext(container)
        let highROI = makeItem(id: "h", target: 80, cost: 10, context: context)
        let lowROI = makeItem(id: "l", target: 30, cost: 20, context: context)
        let noCost = makeItem(id: "n", target: 50, cost: nil, context: context)

        XCTAssertTrue(SortOption.bestROI.isOrdered(highROI, lowROI),
                      "ROI 7.0 should beat ROI 0.5")
        XCTAssertTrue(SortOption.bestROI.isOrdered(highROI, noCost),
                      "Items with cost should beat items without")
    }

    func test_sort_skuNatural_usesNaturalCompare() throws {
        let container = try makeContainer()
        let context = ModelContext(container)
        let two = makeItem(id: "x", sku: "S-2", context: context)
        let ten = makeItem(id: "y", sku: "S-10", context: context)

        XCTAssertTrue(SortOption.skuNatural.isOrdered(two, ten),
                      "S-2 should sort before S-10")
        XCTAssertFalse(SortOption.skuNatural.isOrdered(ten, two))
    }

    // MARK: - InventoryFilter

    func test_filter_searchMatchesTitle() throws {
        let context = ModelContext(try makeContainer())
        let items = [
            makeItem(id: "a", title: "Linen blazer", context: context),
            makeItem(id: "b", title: "Wool coat", context: context),
            makeItem(id: "c", title: "Cotton shirt", brand: "Levi's", context: context),
        ]
        let result = InventoryFilter.filter(items, search: "wool")
        XCTAssertEqual(result.map(\.id), ["b"])
    }

    func test_filter_searchMatchesBrandAndSku() throws {
        let context = ModelContext(try makeContainer())
        let items = [
            makeItem(id: "a", title: "Tee", brand: "Patagonia", sku: "P-1", context: context),
            makeItem(id: "b", title: "Tee", brand: "Nike", sku: "N-2", context: context),
        ]
        XCTAssertEqual(
            InventoryFilter.filter(items, search: "patag").map(\.id),
            ["a"]
        )
        XCTAssertEqual(
            InventoryFilter.filter(items, search: "n-2").map(\.id),
            ["b"]
        )
    }

    func test_filter_emptyOrWhitespaceSearch_returnsAll() throws {
        let context = ModelContext(try makeContainer())
        let items = [
            makeItem(id: "a", title: "x", context: context),
            makeItem(id: "b", title: "y", context: context),
        ]
        XCTAssertEqual(InventoryFilter.filter(items, search: "").map(\.id), ["a", "b"])
        XCTAssertEqual(InventoryFilter.filter(items, search: "   ").map(\.id), ["a", "b"])
    }

    func test_apply_combinesStageSearchSort() throws {
        let context = ModelContext(try makeContainer())
        let items = [
            makeItem(id: "draft1", title: "Wool blazer", status: "drafted",
                     createdAt: Date(timeIntervalSince1970: 300), context: context),
            makeItem(id: "draft2", title: "Wool coat", status: "drafted",
                     createdAt: Date(timeIntervalSince1970: 200), context: context),
            makeItem(id: "active1", title: "Wool sweater", status: "listed",
                     createdAt: Date(timeIntervalSince1970: 500), context: context),
        ]
        let result = InventoryFilter.apply(
            items,
            stage: .drafts,
            search: "wool",
            sort: .newest
        )
        // Stage cut to drafts (drops active1), search matches both, sort
        // newest puts draft1 first (createdAt 300 > 200).
        XCTAssertEqual(result.map(\.id), ["draft1", "draft2"])
    }

    // MARK: - Helpers

    private func makeContainer() throws -> ModelContainer {
        let schema = Schema([
            LocalInventoryItem.self,
            LocalItemPhoto.self,
            LocalListing.self,
            LocalSale.self,
            LocalSource.self,
            LocalPendingMutation.self,
        ])
        let config = ModelConfiguration(
            schema: schema,
            isStoredInMemoryOnly: true,
            cloudKitDatabase: .none
        )
        return try ModelContainer(for: schema, configurations: config)
    }

    private func makeItem(
        id: String,
        title: String = "Item",
        brand: String? = nil,
        sku: String? = nil,
        status: String = "cataloged",
        target: Double? = nil,
        cost: Double? = nil,
        createdAt: Date = .now,
        context: ModelContext
    ) -> LocalInventoryItem {
        let item = LocalInventoryItem(
            id: id, userId: "u",
            title: title, status: status,
            createdAt: createdAt, updatedAt: createdAt
        )
        item.brand = brand
        item.sku = sku
        item.targetPrice = target
        item.acquiredPrice = cost
        context.insert(item)
        return item
    }
}
