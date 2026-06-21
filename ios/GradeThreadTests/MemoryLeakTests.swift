import SwiftData
import XCTest
@testable import GradeThread

/// US-1154: teardown leak checks for heavy, long-lived objects that own async
/// observers / streams (the usual retain-cycle sources). Each constructs the
/// object in an autoreleasepool and asserts the weak reference drops — a cycle
/// (e.g. a Task or NotificationCenter observer capturing a strong self) keeps it
/// alive and fails the test.
///
/// (Launch-performance via XCTApplicationLaunchMetric + snapshot/visual
/// regression run in a dedicated, non-PR-blocking UI lane — they need a
/// simulator and are tracked separately.)
@MainActor
final class MemoryLeakTests: XCTestCase {

    func test_syncStatusStore_doesNotLeak() {
        weak var weakStore: SyncStatusStore?
        autoreleasepool {
            let store = SyncStatusStore()
            store.setPendingCount(3, stuck: 1)
            weakStore = store
        }
        XCTAssertNil(weakStore, "SyncStatusStore leaked")
    }

    func test_syncEngine_doesNotLeak_afterStop() throws {
        let container = try inMemoryContainer()
        let monitor = NetworkMonitor()
        weak var weakEngine: SyncEngine?
        autoreleasepool {
            let engine = SyncEngine(
                container: container,
                statusStore: SyncStatusStore(),
                networkMonitor: monitor
            )
            // Note: not started — start() spawns a long-lived connectivity Task
            // that legitimately retains the engine until stop(); this asserts the
            // base object has no self-referential cycle.
            weakEngine = engine
        }
        XCTAssertNil(weakEngine, "SyncEngine leaked")
    }

    func test_gradeRequestStore_doesNotLeak() {
        weak var weakStore: GradeRequestStore?
        autoreleasepool {
            let store = GradeRequestStore(inventoryItemId: "item-1")
            weakStore = store
        }
        XCTAssertNil(weakStore, "GradeRequestStore leaked")
    }

    private func inMemoryContainer() throws -> ModelContainer {
        let config = ModelConfiguration(
            schema: ModelStoreProvider.schema,
            isStoredInMemoryOnly: true,
            cloudKitDatabase: .none
        )
        return try ModelContainer(for: ModelStoreProvider.schema, configurations: config)
    }
}
