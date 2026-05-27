import XCTest
import SwiftData
@testable import GradeThread

@MainActor
final class SyncTests: XCTestCase {

    // MARK: - ConflictPolicy

    func test_serverOwned_alwaysReturnsServerValue() {
        XCTAssertEqual(ConflictPolicy.resolveServerOwned(local: 10.0, server: 25.0), 25.0)
        XCTAssertEqual(ConflictPolicy.resolveServerOwned(local: "draft", server: "active"), "active")
    }

    func test_userOwned_keepsLocalWhenDirty() {
        let result = ConflictPolicy.resolveUserOwned(
            local: "Linen blazer (edited)",
            server: "Linen blazer",
            hasLocalChanges: true
        )
        XCTAssertEqual(result, "Linen blazer (edited)")
    }

    func test_userOwned_acceptsServerWhenClean() {
        let result = ConflictPolicy.resolveUserOwned(
            local: "Linen blazer",
            server: "Linen blazer (server-updated)",
            hasLocalChanges: false
        )
        XCTAssertEqual(result, "Linen blazer (server-updated)")
    }

    func test_byTimestamp_pickserverWhenNewer() {
        let local = "old-notes"
        let server = "new-notes"
        let localUpdate = Date(timeIntervalSince1970: 100)
        let serverUpdate = Date(timeIntervalSince1970: 200)

        let result = ConflictPolicy.resolveByTimestamp(
            local: local,
            server: server,
            localUpdatedAt: localUpdate,
            serverUpdatedAt: serverUpdate
        )
        XCTAssertEqual(result, server)
    }

    func test_byTimestamp_pickslocalWhenNewer() {
        let result = ConflictPolicy.resolveByTimestamp(
            local: "local-latest",
            server: "server-stale",
            localUpdatedAt: Date(timeIntervalSince1970: 200),
            serverUpdatedAt: Date(timeIntervalSince1970: 100)
        )
        XCTAssertEqual(result, "local-latest")
    }

    // MARK: - PendingMutation queue

    func test_pendingMutation_roundtripsThroughSwiftData() throws {
        let container = try inMemoryContainer()
        let context = ModelContext(container)

        struct CreateItemPayload: Codable, Equatable {
            let title: String
            let brand: String?
        }

        let payload = CreateItemPayload(title: "Wool coat", brand: "Pendleton")
        let payloadData = try JSONEncoder().encode(payload)

        let mutation = LocalPendingMutation(
            kind: .createInventoryItem,
            payload: payloadData,
            targetId: nil
        )
        context.insert(mutation)
        try context.save()

        // Read back through a fresh context to verify persistence.
        let readContext = ModelContext(container)
        let descriptor = FetchDescriptor<LocalPendingMutation>()
        let rows = try readContext.fetch(descriptor)

        XCTAssertEqual(rows.count, 1)
        let row = try XCTUnwrap(rows.first)
        XCTAssertEqual(row.kindEnum, .createInventoryItem)
        XCTAssertEqual(row.retryCount, 0)
        let decoded = try JSONDecoder().decode(CreateItemPayload.self, from: row.payload)
        XCTAssertEqual(decoded, payload)
    }

    func test_pendingMutation_unknownKindIsDetectable() {
        let mutation = LocalPendingMutation(
            kind: .createInventoryItem,
            payload: Data()
        )
        // Stomp the raw storage as if a future client wrote a kind we don't
        // know yet. kindEnum should yield nil so the engine can shelve it.
        mutation.kind = "future_kind_we_dont_know"
        XCTAssertNil(mutation.kindEnum)
    }

    // MARK: - SyncStatusStore

    func test_statusStore_promotesIdleToPendingWhenQueueGrows() {
        let store = SyncStatusStore()
        XCTAssertEqual(store.phase, .idle)
        XCTAssertEqual(store.pendingCount, 0)

        store.setPendingCount(3)
        XCTAssertEqual(store.phase, .pending)
        XCTAssertEqual(store.pendingCount, 3)
    }

    func test_statusStore_demotesPendingBackToIdleWhenQueueDrains() {
        let store = SyncStatusStore()
        store.setPendingCount(2)
        XCTAssertEqual(store.phase, .pending)

        store.setPendingCount(0)
        XCTAssertEqual(store.phase, .idle)
    }

    func test_statusStore_doesNotOverrideSyncingWhilePending() {
        let store = SyncStatusStore()
        store.set(.syncing)
        store.setPendingCount(5)
        // Mid-sync we want the spinner, not the "5 pending" banner — the
        // engine flips back to .pending explicitly when the sync ends.
        XCTAssertEqual(store.phase, .syncing)
        XCTAssertEqual(store.pendingCount, 5)
    }

    // MARK: - Helpers

    private func inMemoryContainer() throws -> ModelContainer {
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
}
