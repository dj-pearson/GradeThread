import XCTest
import SwiftData
@testable import GradeThread

/// Covers the advanced faceted filtering added on top of the stage/search/
/// sort pipeline: `InventoryFilterCriteria`, `InventoryFilter.matches`,
/// `InventoryFacets.derive`, and `SavedFilterStore`.
@MainActor
final class AdvancedInventoryFilterTests: XCTestCase {

    // MARK: - Criteria activeness

    func test_emptyCriteria_isInactive() {
        XCTAssertFalse(InventoryFilterCriteria.empty.isActive)
        XCTAssertEqual(InventoryFilterCriteria.empty.activeCount, 0)
    }

    func test_activeCount_countsEachFacetOnce() {
        var c = InventoryFilterCriteria()
        c.brands = ["Nike", "Patagonia"]   // multi-select still counts once
        c.minPrice = 10
        c.maxPrice = 50                     // both bounds → one facet
        c.dateAdded = .last30
        XCTAssertTrue(c.isActive)
        XCTAssertEqual(c.activeCount, 3)
    }

    func test_minGrade_countsAsGradeFacet() {
        var c = InventoryFilterCriteria()
        c.minGrade = 8.0
        XCTAssertEqual(c.activeCount, 1)
    }

    // MARK: - matches: attribute facets

    func test_matches_brandMultiSelect_isOR() throws {
        let ctx = ModelContext(try makeContainer())
        let nike = makeItem(id: "n", brand: "Nike", context: ctx)
        let levis = makeItem(id: "l", brand: "Levi's", context: ctx)
        let other = makeItem(id: "o", brand: "Gap", context: ctx)

        var c = InventoryFilterCriteria()
        c.brands = ["Nike", "Levi's"]
        XCTAssertTrue(InventoryFilter.matches(nike, c))
        XCTAssertTrue(InventoryFilter.matches(levis, c))
        XCTAssertFalse(InventoryFilter.matches(other, c))
    }

    func test_matches_acrossFacets_isAND() throws {
        let ctx = ModelContext(try makeContainer())
        let item = makeItem(id: "a", brand: "Nike", size: "L", context: ctx)

        var c = InventoryFilterCriteria()
        c.brands = ["Nike"]
        c.sizes = ["M"]   // mismatched size → fails the AND
        XCTAssertFalse(InventoryFilter.matches(item, c))

        c.sizes = ["L"]
        XCTAssertTrue(InventoryFilter.matches(item, c))
    }

    func test_matches_blankAttribute_failsWhenFacetActive() throws {
        let ctx = ModelContext(try makeContainer())
        let noBrand = makeItem(id: "x", brand: nil, context: ctx)
        var c = InventoryFilterCriteria()
        c.brands = ["Nike"]
        XCTAssertFalse(InventoryFilter.matches(noBrand, c))
    }

    // MARK: - matches: grade

    func test_matches_gradedOnly_dropsUngraded() throws {
        let ctx = ModelContext(try makeContainer())
        let graded = makeItem(id: "g", context: ctx); graded.gradeValue = 7.0
        let ungraded = makeItem(id: "u", context: ctx)
        var c = InventoryFilterCriteria(); c.gradedOnly = true
        XCTAssertTrue(InventoryFilter.matches(graded, c))
        XCTAssertFalse(InventoryFilter.matches(ungraded, c))
    }

    func test_matches_minGrade_appliesFloor() throws {
        let ctx = ModelContext(try makeContainer())
        let high = makeItem(id: "h", context: ctx); high.gradeValue = 9.0
        let low = makeItem(id: "l", context: ctx); low.gradeValue = 6.0
        var c = InventoryFilterCriteria(); c.minGrade = 8.0
        XCTAssertTrue(InventoryFilter.matches(high, c))
        XCTAssertFalse(InventoryFilter.matches(low, c))
    }

    // MARK: - matches: price band

    func test_matches_priceBand_usesEffectivePrice() throws {
        let ctx = ModelContext(try makeContainer())
        // No listing/target → falls back to acquired (15).
        let item = makeItem(id: "p", context: ctx)
        item.acquiredPrice = 15
        var c = InventoryFilterCriteria()
        c.minPrice = 10; c.maxPrice = 20
        XCTAssertTrue(InventoryFilter.matches(item, c))
        c.minPrice = 16
        XCTAssertFalse(InventoryFilter.matches(item, c))
    }

    func test_matches_priceBand_dropsItemsWithNoPrice() throws {
        let ctx = ModelContext(try makeContainer())
        let item = makeItem(id: "p", context: ctx)   // no prices
        var c = InventoryFilterCriteria(); c.maxPrice = 100
        XCTAssertFalse(InventoryFilter.matches(item, c))
    }

    // MARK: - matches: photo + date

    func test_matches_photoState() throws {
        let ctx = ModelContext(try makeContainer())
        let withPhoto = makeItem(id: "w", context: ctx); withPhoto.primaryPhotoURL = "https://x/y.jpg"
        let without = makeItem(id: "n", context: ctx)

        var c = InventoryFilterCriteria(); c.photoState = .withPhoto
        XCTAssertTrue(InventoryFilter.matches(withPhoto, c))
        XCTAssertFalse(InventoryFilter.matches(without, c))

        c.photoState = .missingPhoto
        XCTAssertFalse(InventoryFilter.matches(withPhoto, c))
        XCTAssertTrue(InventoryFilter.matches(without, c))
    }

    func test_matches_dateAdded_windowsOnCreatedAt() throws {
        let ctx = ModelContext(try makeContainer())
        let now = Date(timeIntervalSince1970: 1_000_000)
        let recent = makeItem(id: "r", createdAt: now.addingTimeInterval(-2 * 86_400), context: ctx)
        let old = makeItem(id: "o", createdAt: now.addingTimeInterval(-40 * 86_400), context: ctx)

        var c = InventoryFilterCriteria(); c.dateAdded = .last7
        XCTAssertTrue(InventoryFilter.matches(recent, c, now: now))
        XCTAssertFalse(InventoryFilter.matches(old, c, now: now))
    }

    // MARK: - apply: facets compose with stage + search

    func test_apply_criteria_composesWithStageAndSearch() throws {
        let ctx = ModelContext(try makeContainer())
        let items = [
            makeItem(id: "a", title: "Wool blazer", brand: "Nike", status: "drafted", context: ctx),
            makeItem(id: "b", title: "Wool coat", brand: "Gap", status: "drafted", context: ctx),
            makeItem(id: "c", title: "Wool tee", brand: "Nike", status: "listed", context: ctx),
        ]
        var c = InventoryFilterCriteria(); c.brands = ["Nike"]
        let result = InventoryFilter.apply(
            items, stage: .drafts, search: "wool", sort: .newest, criteria: c
        )
        // Stage=drafts drops "c"; brand=Nike drops "b"; "wool" keeps "a".
        XCTAssertEqual(result.map(\.id), ["a"])
    }

    // MARK: - Facets derivation

    func test_facets_countsAndFrequencyOrder() throws {
        let ctx = ModelContext(try makeContainer())
        let items = [
            makeItem(id: "1", brand: "Nike", context: ctx),
            makeItem(id: "2", brand: "Nike", context: ctx),
            makeItem(id: "3", brand: "Gap", context: ctx),
            makeItem(id: "4", brand: "  ", context: ctx),   // blank → dropped
        ]
        let facets = InventoryFacets.derive(from: items)
        XCTAssertEqual(facets.brands.map(\.value), ["Nike", "Gap"])  // freq desc
        XCTAssertEqual(facets.brands.first?.count, 2)
    }

    func test_facets_sizeOrdering_letteredBeforeNumeric() throws {
        let ctx = ModelContext(try makeContainer())
        let items = [
            makeItem(id: "1", size: "XL", context: ctx),
            makeItem(id: "2", size: "S", context: ctx),
            makeItem(id: "3", size: "M", context: ctx),
            makeItem(id: "4", size: "32", context: ctx),
        ]
        let facets = InventoryFacets.derive(from: items)
        XCTAssertEqual(facets.sizes.map(\.value), ["S", "M", "XL", "32"])
    }

    func test_facets_priceBounds() throws {
        let ctx = ModelContext(try makeContainer())
        let a = makeItem(id: "a", context: ctx); a.listingPrice = 25
        let b = makeItem(id: "b", context: ctx); b.targetPrice = 5
        let c = makeItem(id: "c", context: ctx)   // no price
        let facets = InventoryFacets.derive(from: [a, b, c])
        XCTAssertEqual(facets.priceBounds, 5...25)
    }

    func test_facets_priceBounds_nilWhenNoPrices() throws {
        let ctx = ModelContext(try makeContainer())
        let facets = InventoryFacets.derive(from: [makeItem(id: "a", context: ctx)])
        XCTAssertNil(facets.priceBounds)
    }

    // MARK: - SavedFilterStore

    func test_savedFilters_saveOverwriteDelete() throws {
        let defaults = try ephemeralDefaults()
        let store = SavedFilterStore(defaults: defaults)
        XCTAssertTrue(store.filters.isEmpty)

        var c = InventoryFilterCriteria(); c.brands = ["Nike"]
        store.save(name: "Nike", criteria: c)
        XCTAssertEqual(store.filters.count, 1)

        // Same name overwrites rather than duplicating.
        var c2 = InventoryFilterCriteria(); c2.brands = ["Nike"]; c2.gradedOnly = true
        store.save(name: "nike", criteria: c2)
        XCTAssertEqual(store.filters.count, 1)
        XCTAssertEqual(store.filters.first?.criteria, c2)

        store.delete(store.filters[0])
        XCTAssertTrue(store.filters.isEmpty)
    }

    func test_savedFilters_blankNameRejected() throws {
        let store = SavedFilterStore(defaults: try ephemeralDefaults())
        XCTAssertNil(store.save(name: "   ", criteria: .empty))
        XCTAssertTrue(store.filters.isEmpty)
    }

    func test_savedFilters_persistAcrossInstances() throws {
        let defaults = try ephemeralDefaults()
        var c = InventoryFilterCriteria(); c.sizes = ["L"]
        SavedFilterStore(defaults: defaults).save(name: "Large", criteria: c)

        let reloaded = SavedFilterStore(defaults: defaults)
        XCTAssertEqual(reloaded.filters.count, 1)
        XCTAssertEqual(reloaded.matchingName(for: c), "Large")
    }

    // MARK: - Helpers

    private func ephemeralDefaults() throws -> UserDefaults {
        let suite = "test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
        return defaults
    }

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
        size: String? = nil,
        status: String = "cataloged",
        createdAt: Date = .now,
        context: ModelContext
    ) -> LocalInventoryItem {
        let item = LocalInventoryItem(
            id: id, userId: "u",
            title: title, status: status,
            createdAt: createdAt, updatedAt: createdAt
        )
        item.brand = brand
        item.size = size
        context.insert(item)
        return item
    }
}
