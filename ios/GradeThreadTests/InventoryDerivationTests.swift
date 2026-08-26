import XCTest
import SwiftData
@testable import GradeThread

/// US-1017: the inventory screen memoizes its three expensive derivations
/// (filtered+sorted list, per-stage counts, facet index) so an unrelated
/// `@State`-driven `body` re-render doesn't re-run them on the main thread.
/// These tests pin that contract via the cache's pass counters and the pure,
/// shared key builders the view uses.
@MainActor
final class InventoryDerivationTests: XCTestCase {

    // MARK: - Facets: at most once per presentation (AC #1)

    func test_facets_recomputesOnlyWhenKeyChanges() throws {
        let context = ModelContext(try makeContainer())
        let items = [makeItem(id: "a", brand: "Nike", context: context),
                     makeItem(id: "b", brand: "Levi's", context: context)]
        let cache = InventoryDerivation()
        let key = InventoryDerivation.facetsKey(
            itemsSignature: InventoryDerivation.itemsSignature(items),
            sourceNames: [:]
        )

        // Repeated reads with the same key (the filter sheet's body
        // re-evaluating while presented) derive at most once.
        for _ in 0..<5 {
            _ = cache.facets(key: key) { InventoryFacets.derive(from: items, sourceNames: [:]) }
        }
        XCTAssertEqual(cache.facetsPassCount, 1)

        // A different source-name map (a rename) is a genuine input change.
        let renamedKey = InventoryDerivation.facetsKey(
            itemsSignature: InventoryDerivation.itemsSignature(items),
            sourceNames: ["src-1": "Goodwill"]
        )
        _ = cache.facets(key: renamedKey) { InventoryFacets.derive(from: items, sourceNames: [:]) }
        XCTAssertEqual(cache.facetsPassCount, 2)
    }

    // MARK: - Filtered list: recompute only on relevant input change (AC #2)

    func test_filteredItems_recomputesOnlyOnRelevantInputChange() throws {
        let context = ModelContext(try makeContainer())
        let items = [makeItem(id: "a", status: "cataloged", context: context),
                     makeItem(id: "b", status: "drafted", context: context)]
        let cache = InventoryDerivation()
        let sig = InventoryDerivation.itemsSignature(items)

        func run(stage: InventoryStage = .all,
                 query: String = "",
                 sort: SortOption = .newest,
                 criteria: InventoryFilterCriteria = .empty) {
            let key = InventoryDerivation.filterKey(
                itemsSignature: sig, stage: stage, query: query, sort: sort,
                criteria: criteria, soldDates: [:], serverSearchIds: nil
            )
            _ = cache.filteredItems(key: key) {
                InventoryFilter.apply(items, stage: stage, search: query,
                                      sort: sort, criteria: criteria)
            }
        }

        // Identical inputs across many renders → one pass.
        for _ in 0..<5 { run() }
        XCTAssertEqual(cache.filterPassCount, 1)

        // Each relevant change forces exactly one more pass.
        run(stage: .drafts)
        XCTAssertEqual(cache.filterPassCount, 2)
        run(query: "shirt")
        XCTAssertEqual(cache.filterPassCount, 3)
        run(sort: .oldest)
        XCTAssertEqual(cache.filterPassCount, 4)
        var criteria = InventoryFilterCriteria(); criteria.gradedOnly = true
        run(criteria: criteria)
        XCTAssertEqual(cache.filterPassCount, 5)
    }

    // MARK: - Stage counts: recompute only on item-signature change

    func test_stageCounts_recomputesOnlyOnItemSignatureChange() throws {
        let context = ModelContext(try makeContainer())
        let items = [makeItem(id: "a", status: "cataloged", context: context)]
        let cache = InventoryDerivation()

        func counts(_ snapshot: [LocalInventoryItem]) -> [InventoryStage: Int] {
            cache.stageCounts(key: InventoryDerivation.itemsSignature(snapshot)) {
                var out: [InventoryStage: Int] = [:]
                for item in snapshot {
                    for stage in InventoryStage.userFacing
                    where stage.matchingStatuses.contains(item.status) {
                        out[stage, default: 0] += 1
                    }
                }
                return out
            }
        }

        for _ in 0..<5 { _ = counts(items) }
        XCTAssertEqual(cache.stageCountsPassCount, 1)

        // Adding an item changes the signature → one recompute.
        let grown = items + [makeItem(id: "b", status: "drafted", context: context)]
        _ = counts(grown)
        XCTAssertEqual(cache.stageCountsPassCount, 2)
    }

    // MARK: - Unrelated state change leaves the key (and so the memo) intact (AC #3)

    func test_unrelatedStateChange_doesNotInvalidateFilterMemo() throws {
        let context = ModelContext(try makeContainer())
        let items = [makeItem(id: "a", status: "cataloged", context: context)]
        let cache = InventoryDerivation()
        let sig = InventoryDerivation.itemsSignature(items)

        // The filter key depends ONLY on the filter inputs — none of which an
        // unrelated `@State` flip (opening the sync sheet, toggling select mode,
        // a refresh banner) touches. So the key is byte-stable across such a
        // render, and the full filter pass never re-runs.
        let key1 = InventoryDerivation.filterKey(
            itemsSignature: sig, stage: .all, query: "", sort: .newest,
            criteria: .empty, soldDates: [:], serverSearchIds: nil
        )
        let key2 = InventoryDerivation.filterKey(
            itemsSignature: sig, stage: .all, query: "", sort: .newest,
            criteria: .empty, soldDates: [:], serverSearchIds: nil
        )
        XCTAssertEqual(key1, key2, "unrelated re-render must not change the filter key")

        _ = cache.filteredItems(key: key1) {
            InventoryFilter.apply(items, stage: .all, search: "", sort: .newest, criteria: .empty)
        }
        _ = cache.filteredItems(key: key2) {
            InventoryFilter.apply(items, stage: .all, search: "", sort: .newest, criteria: .empty)
        }
        XCTAssertEqual(cache.filterPassCount, 1,
                       "an unrelated body re-render must not trigger a second filter pass")
    }

    // MARK: - Signature sensitivity

    func test_itemsSignature_changesWhenAnItemIsEdited() throws {
        let context = ModelContext(try makeContainer())
        let item = makeItem(id: "a", status: "cataloged", context: context)
        let before = InventoryDerivation.itemsSignature([item])
        item.updatedAt = item.updatedAt.addingTimeInterval(60)
        let after = InventoryDerivation.itemsSignature([item])
        XCTAssertNotEqual(before, after, "an edit (bumped updatedAt) must invalidate the signature")
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
        let config = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true, cloudKitDatabase: .none)
        return try ModelContainer(for: schema, configurations: config)
    }

    private func makeItem(
        id: String,
        brand: String? = nil,
        status: String = "cataloged",
        context: ModelContext
    ) -> LocalInventoryItem {
        let item = LocalInventoryItem(
            id: id, userId: "u", title: "Item", status: status,
            createdAt: Date(timeIntervalSince1970: 1_000),
            updatedAt: Date(timeIntervalSince1970: 1_000)
        )
        item.brand = brand
        context.insert(item)
        return item
    }
}
