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

    func test_sort_highestGrade_putsGradedFirst_ungradedLast() throws {
        let context = ModelContext(try makeContainer())
        let high = makeItem(id: "h", context: context); high.gradeValue = 9.0
        let low = makeItem(id: "l", context: context); low.gradeValue = 5.0
        let ungraded = makeItem(id: "u", context: context)  // nil grade

        XCTAssertTrue(SortOption.highestGrade.isOrdered(high, low),
                      "9.0 should sort before 5.0")
        XCTAssertTrue(SortOption.highestGrade.isOrdered(low, ungraded),
                      "a graded item should sort before an ungraded one")
        XCTAssertFalse(SortOption.highestGrade.isOrdered(ungraded, high))
    }

    // US-3124: who bought the item. Nobody recorded sorts LAST in BOTH
    // directions — the web's NULLS LAST, and what Android does — because an
    // item with no sourcer is unknown, not "before A".
    func test_sort_sourcer_ordersByNameAndSinksTheUnassigned() throws {
        let context = ModelContext(try makeContainer())
        let alex = makeItem(id: "a", context: context); alex.sourcedBy = "Alex"
        let dan = makeItem(id: "d", context: context); dan.sourcedBy = "dan"
        let nobody = makeItem(id: "n", context: context)
        let blank = makeItem(id: "b", context: context); blank.sourcedBy = "  "

        XCTAssertTrue(SortOption.sourcerAZ.isOrdered(alex, dan))
        XCTAssertFalse(SortOption.sourcerAZ.isOrdered(dan, alex))
        // Case-insensitive: "dan" is not sorted apart from "Dan".
        XCTAssertTrue(SortOption.sourcerZA.isOrdered(dan, alex))

        for direction in [SortOption.sourcerAZ, SortOption.sourcerZA] {
            XCTAssertTrue(direction.isOrdered(alex, nobody),
                          "\(direction.rawValue): a named item beats an unassigned one")
            XCTAssertFalse(direction.isOrdered(nobody, alex))
            XCTAssertTrue(direction.isOrdered(dan, blank),
                          "\(direction.rawValue): whitespace counts as unassigned")
        }
    }

    func test_sort_sourcer_tieBreaksNewestThenId() throws {
        let context = ModelContext(try makeContainer())
        let older = makeItem(
            id: "a", createdAt: Date(timeIntervalSince1970: 100), context: context
        )
        older.sourcedBy = "Dan"
        let newer = makeItem(
            id: "b", createdAt: Date(timeIntervalSince1970: 200), context: context
        )
        newer.sourcedBy = "Dan"
        XCTAssertTrue(SortOption.sourcerAZ.isOrdered(newer, older),
                      "one person's items read newest first")
    }

    // MARK: - Graded-only filter

    func test_apply_gradedOnly_dropsUngradedItems() throws {
        let context = ModelContext(try makeContainer())
        let graded = makeItem(id: "g", status: "cataloged", context: context)
        graded.gradeValue = 8.0
        let ungraded = makeItem(id: "u", status: "cataloged", context: context)
        let items = [graded, ungraded]

        let all = InventoryFilter.apply(
            items, stage: .all, search: "", sort: .newest, gradedOnly: false
        )
        XCTAssertEqual(Set(all.map(\.id)), ["g", "u"])

        let onlyGraded = InventoryFilter.apply(
            items, stage: .all, search: "", sort: .newest, gradedOnly: true
        )
        XCTAssertEqual(onlyGraded.map(\.id), ["g"])
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

    func test_filter_searchMatchesStyleAndGarmentType() throws {
        // US-1248: style/garmentType/garmentCategory are mirrored locally and
        // must be searchable offline.
        let context = ModelContext(try makeContainer())
        let a = makeItem(id: "a", title: "Tee", context: context)
        a.style = "Bomber"
        a.garmentType = "Jacket"
        let b = makeItem(id: "b", title: "Tee", context: context)
        b.style = "Crewneck"
        b.garmentType = "Sweater"
        let items = [a, b]
        XCTAssertEqual(InventoryFilter.filter(items, search: "bomber").map(\.id), ["a"])
        XCTAssertEqual(InventoryFilter.filter(items, search: "sweater").map(\.id), ["b"])
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
            LocalSourcer.self,
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
