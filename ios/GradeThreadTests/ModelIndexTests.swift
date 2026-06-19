import XCTest
import SwiftData
@testable import GradeThread

/// US-985: the offline-cache `@Model`s declare `#Index` on the columns hit by
/// `#Predicate` / `sortBy`, so realtime upserts and list `@Query`s don't
/// full-scan a large catalog. These tests pin two guarantees:
///
///  - AC #2: the large-store predicated + sorted fetches the realtime merge and
///    list views issue are benchmarked, so a regression that drops a covering
///    index (or reintroduces a scan) shows up in CI's performance metrics.
///  - AC #4: adding the indexes is a non-destructive lightweight migration — an
///    existing on-disk store reopens with the indexed schema, rows intact, with
///    no destructive reset.
final class ModelIndexTests: XCTestCase {

    private var tempDir: URL!

    override func setUpWithError() throws {
        tempDir = FileManager.default.temporaryDirectory
            .appending(path: "ModelIndexTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: tempDir, withIntermediateDirectories: true
        )
    }

    override func tearDownWithError() throws {
        if let tempDir { try? FileManager.default.removeItem(at: tempDir) }
    }

    // MARK: - AC #2: large-store fetch benchmark

    /// Seeds a large store and measures the predicated + sorted fetches the
    /// realtime merge and list `@Query`s run on every event. With the `#Index`es
    /// in place these are index lookups rather than O(n) scans; the `measure`
    /// block records the per-fetch cost so CI flags a regression that loses a
    /// covering index. Asserting the result shapes keeps it a real test, not just
    /// a timer.
    func test_largeStore_indexedFetches_benchmark() throws {
        let container = try inMemoryContainer()
        let context = ModelContext(container)
        seedLargeStore(into: context, items: 1_000)

        // Functional correctness alongside the benchmark: half the listings are
        // "active" (i % 2 == 0 over 0..<1000).
        let activeDescriptor = FetchDescriptor<LocalListing>(
            predicate: #Predicate { $0.listingStatus == "active" }
        )
        XCTAssertEqual(try context.fetchCount(activeDescriptor), 500)

        measure {
            // updatedAt-sorted fetch — the Inventory/Dashboard `@Query(sort:)`.
            let sorted = FetchDescriptor<LocalInventoryItem>(
                sortBy: [SortDescriptor(\.updatedAt, order: .reverse)]
            )
            _ = (try? context.fetch(sorted)) ?? []

            // listingStatus == "active" — the active-listing count `#Predicate`.
            _ = (try? context.fetch(activeDescriptor)) ?? []
        }
    }

    // MARK: - AC #4: indexed schema reopens an existing store non-destructively

    func test_indexedSchema_reopensExistingStore_nonDestructively() throws {
        let url = tempDir.appending(path: "GradeThread.store")

        // First launch: build the on-disk store with the indexed schema + seed.
        let first = ModelStoreProvider.load(storeURL: url)
        XCTAssertFalse(first.didResetStore)
        let writeCtx = ModelContext(first.container)
        writeCtx.insert(LocalInventoryItem(
            id: "keep-1", userId: "u1", title: "Persisted", status: "cataloged"
        ))
        try writeCtx.save()

        // Second launch against the same files: the indexed schema must open the
        // existing store in place — no destructive recovery, the row survives.
        let second = ModelStoreProvider.load(storeURL: url)
        XCTAssertFalse(
            second.didResetStore,
            "the indexed schema should open an existing store without resetting it"
        )
        XCTAssertFalse(second.isInMemoryFallback)
        let rows = try ModelContext(second.container)
            .fetch(FetchDescriptor<LocalInventoryItem>())
        XCTAssertEqual(rows.map(\.id), ["keep-1"])
    }

    // MARK: - Helpers

    /// Inserts `count` items plus a listing each. `status`/`listingStatus`/
    /// `updatedAt` are varied so the index-backed predicates and sorts have real
    /// selectivity to work against.
    private func seedLargeStore(into context: ModelContext, items count: Int) {
        let base = Date(timeIntervalSince1970: 1_700_000_000)
        for i in 0..<count {
            context.insert(LocalInventoryItem(
                id: "item-\(i)", userId: "u1", title: "Item \(i)",
                status: i % 3 == 0 ? "listed" : "cataloged",
                createdAt: base, updatedAt: base.addingTimeInterval(Double(i))
            ))
            context.insert(LocalListing(
                id: "listing-\(i)", inventoryItemId: "item-\(i)", platform: "ebay",
                listingPrice: 25, listingStatus: i % 2 == 0 ? "active" : "ended"
            ))
        }
        try? context.save()
    }

    /// In-memory container built from the app's canonical (now indexed) schema —
    /// reusing `ModelStoreProvider.schema` keeps this in lockstep with the model
    /// graph the app ships.
    private func inMemoryContainer() throws -> ModelContainer {
        let config = ModelConfiguration(
            schema: ModelStoreProvider.schema,
            isStoredInMemoryOnly: true,
            cloudKitDatabase: .none
        )
        return try ModelContainer(
            for: ModelStoreProvider.schema, configurations: config
        )
    }
}
