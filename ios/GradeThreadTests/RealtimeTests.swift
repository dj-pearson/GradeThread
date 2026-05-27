import XCTest
import SwiftData
@testable import GradeThread

@MainActor
final class RealtimeTests: XCTestCase {

    private let realtimeToggleKey = "com.gradethread.app.realtime.enabled"

    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: realtimeToggleKey)
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: realtimeToggleKey)
        super.tearDown()
    }

    // MARK: - SyncStatusStore.Phase

    func test_phase_reconnectingExists() {
        // Pin the case existence so a refactor doesn't silently drop
        // it (the SyncStatusBar branches on this).
        let phase: SyncStatusStore.Phase = .reconnecting
        XCTAssertEqual(phase, .reconnecting)
    }

    func test_statusStore_setReconnecting_andBack() {
        let store = SyncStatusStore()
        XCTAssertEqual(store.phase, .idle)
        store.set(.reconnecting)
        XCTAssertEqual(store.phase, .reconnecting)
        store.set(.idle)
        XCTAssertEqual(store.phase, .idle)
    }

    // MARK: - SyncEngine.applyRealtimeInventoryUpsert + delete

    func test_realtimeUpsert_insertsRow_whenAbsent() async throws {
        let container = try makeContainer()
        let status = SyncStatusStore()
        let monitor = NetworkMonitor()
        let engine = SyncEngine(
            container: container, statusStore: status, networkMonitor: monitor
        )

        // Insert a row that doesn't yet exist locally.
        let payload = makeInventoryRecord(
            id: "rt-1",
            userId: "u",
            title: "Linen blazer",
            status: "cataloged"
        )
        await engine.applyRealtimeInventoryUpsert(record: payload)

        let context = ModelContext(container)
        let descriptor = FetchDescriptor<LocalInventoryItem>()
        let rows = try context.fetch(descriptor)
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.title, "Linen blazer")
    }

    func test_realtimeUpsert_updatesRow_whenPresent() async throws {
        let container = try makeContainer()
        let status = SyncStatusStore()
        let monitor = NetworkMonitor()
        let engine = SyncEngine(
            container: container, statusStore: status, networkMonitor: monitor
        )

        // Seed the cache.
        let context = ModelContext(container)
        let initial = LocalInventoryItem(
            id: "rt-2", userId: "u", title: "Stale title",
            status: "cataloged", createdAt: .now, updatedAt: .now
        )
        context.insert(initial)
        try context.save()

        // Realtime update.
        let payload = makeInventoryRecord(
            id: "rt-2",
            userId: "u",
            title: "Fresh title",
            status: "graded"
        )
        await engine.applyRealtimeInventoryUpsert(record: payload)

        let readContext = ModelContext(container)
        let descriptor = FetchDescriptor<LocalInventoryItem>(
            predicate: #Predicate { $0.id == "rt-2" }
        )
        let row = try readContext.fetch(descriptor).first
        XCTAssertEqual(row?.title, "Fresh title")
        XCTAssertEqual(row?.status, "graded")
    }

    func test_realtimeDelete_removesRow() async throws {
        let container = try makeContainer()
        let status = SyncStatusStore()
        let monitor = NetworkMonitor()
        let engine = SyncEngine(
            container: container, statusStore: status, networkMonitor: monitor
        )

        let context = ModelContext(container)
        let row = LocalInventoryItem(
            id: "rt-3", userId: "u", title: "X",
            status: "cataloged", createdAt: .now, updatedAt: .now
        )
        context.insert(row)
        try context.save()

        await engine.applyRealtimeInventoryDelete(id: "rt-3")

        let readContext = ModelContext(container)
        let descriptor = FetchDescriptor<LocalInventoryItem>()
        let rows = try readContext.fetch(descriptor)
        XCTAssertTrue(rows.isEmpty)
    }

    func test_realtimeUpsert_garbageJSON_doesNotCrash() async throws {
        let container = try makeContainer()
        let status = SyncStatusStore()
        let monitor = NetworkMonitor()
        let engine = SyncEngine(
            container: container, statusStore: status, networkMonitor: monitor
        )
        // Malformed payload — missing required fields. Engine should log
        // and move on rather than crashing the realtime listen loop.
        let garbage = Data("{\"id\":\"x\"}".utf8)
        await engine.applyRealtimeInventoryUpsert(record: garbage)
        // No row should land in the cache.
        let context = ModelContext(container)
        let rows = try context.fetch(FetchDescriptor<LocalInventoryItem>())
        XCTAssertTrue(rows.isEmpty)
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

    /// Builds an inventory_items realtime record matching the
    /// RemoteInventoryItem wire shape SyncEngine decodes against.
    private func makeInventoryRecord(
        id: String,
        userId: String,
        title: String,
        status: String
    ) -> Data {
        let dict: [String: Any] = [
            "id": id,
            "user_id": userId,
            "title": title,
            "brand": NSNull(),
            "sku": NSNull(),
            "size": NSNull(),
            "color": NSNull(),
            "material": NSNull(),
            "status": status,
            "target_price": NSNull(),
            "acquired_price": NSNull(),
            "grade_value": NSNull(),
            "grade_label": NSNull(),
            "certificate_url": NSNull(),
            "condition_notes": NSNull(),
            "measurements": NSNull(),
            "created_at": "2026-05-27T12:00:00Z",
            "updated_at": "2026-05-27T12:00:00Z",
        ]
        return try! JSONSerialization.data(withJSONObject: dict)
    }
}
