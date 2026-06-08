import XCTest
@testable import GradeThread

/// US-671: multiple eBay account connections — model decode + store behavior.
@MainActor
final class EbayAccountsTests: XCTestCase {

    // MARK: - Decode

    func test_connection_decodesLabelAndPrimary() throws {
        let json = #"""
        {
          "id": "c1", "marketplace": "ebay", "account_handle": "store_one",
          "label": "Main store", "is_primary": true, "is_active": true,
          "last_synced_at": null, "refresh_error": null,
          "created_at": "2026-05-01T00:00:00Z", "updated_at": "2026-05-01T00:00:00Z"
        }
        """#
        let row = try JSONDecoder().decode(RemoteMarketplaceConnection.self, from: Data(json.utf8))
        XCTAssertEqual(row.label, "Main store")
        XCTAssertTrue(row.isPrimary)
        XCTAssertEqual(row.displayName, "Main store")
    }

    func test_connection_defaultsPrimaryFalseWhenMissing() throws {
        // Rows from before the is_primary column existed.
        let json = #"""
        {
          "id": "c1", "marketplace": "ebay", "account_handle": "store_one",
          "is_active": true, "created_at": "2026-05-01T00:00:00Z",
          "updated_at": "2026-05-01T00:00:00Z"
        }
        """#
        let row = try JSONDecoder().decode(RemoteMarketplaceConnection.self, from: Data(json.utf8))
        XCTAssertFalse(row.isPrimary)
        XCTAssertNil(row.label)
        XCTAssertEqual(row.displayName, "store_one")
    }

    // MARK: - Store

    func test_store_loadsConnections() async {
        let fake = FakeConnections(connections: [
            .init(id: "a", accountHandle: "store_a", isPrimary: true),
            .init(id: "b", accountHandle: "store_b"),
        ])
        let store = EbayAccountsStore(userId: "u", service: fake)
        await store.load()
        XCTAssertEqual(store.phase, .ready)
        XCTAssertEqual(store.connections.count, 2)
        XCTAssertEqual(store.selected?.id, "a")
    }

    func test_store_makePrimary_switchesSelection() async {
        let fake = FakeConnections(connections: [
            .init(id: "a", accountHandle: "store_a", isPrimary: true),
            .init(id: "b", accountHandle: "store_b"),
        ])
        let store = EbayAccountsStore(userId: "u", service: fake)
        await store.load()
        await store.makePrimary(store.connections.first { $0.id == "b" }!)
        XCTAssertEqual(store.selected?.id, "b")
        XCTAssertEqual(fake.setPrimaryCalls, ["b"])
        // Exactly one primary after the switch.
        XCTAssertEqual(store.connections.filter(\.isPrimary).count, 1)
    }

    func test_store_addAccount_reloads() async {
        let fake = FakeConnections(connections: [])
        let store = EbayAccountsStore(userId: "u", service: fake)
        await store.load()
        XCTAssertTrue(store.connections.isEmpty)
        await store.addAccount()
        XCTAssertEqual(fake.connectCalls, 1)
        XCTAssertEqual(store.connections.count, 1)
    }

    func test_store_disconnect_removes() async {
        let fake = FakeConnections(connections: [
            .init(id: "a", accountHandle: "store_a", isPrimary: true),
            .init(id: "b", accountHandle: "store_b"),
        ])
        let store = EbayAccountsStore(userId: "u", service: fake)
        await store.load()
        await store.disconnect(store.connections.first { $0.id == "b" }!)
        XCTAssertFalse(store.connections.contains { $0.id == "b" })
    }

    // MARK: - Fake

    @MainActor
    final class FakeConnections: EbayConnectionsProviding {
        var connections: [RemoteMarketplaceConnection]
        var setPrimaryCalls: [String] = []
        var connectCalls = 0

        init(connections: [RemoteMarketplaceConnection]) {
            self.connections = connections
        }

        func fetchAllConnections(userId: String) async throws -> [RemoteMarketplaceConnection] {
            connections.sorted { ($0.isPrimary ? 0 : 1, $0.id) < ($1.isPrimary ? 0 : 1, $1.id) }
        }

        func connect(userId: String) async throws -> RemoteMarketplaceConnection {
            connectCalls += 1
            let new = RemoteMarketplaceConnection(id: "new", accountHandle: "added")
            connections.append(new)
            return new
        }

        func disconnect(connectionId: String, userId: String) async throws {
            connections.removeAll { $0.id == connectionId }
        }

        func setLabel(connectionId: String, userId: String, label: String?) async throws {
            connections = connections.map {
                guard $0.id == connectionId else { return $0 }
                return RemoteMarketplaceConnection(
                    id: $0.id, accountHandle: $0.accountHandle, label: label,
                    isPrimary: $0.isPrimary, isActive: $0.isActive
                )
            }
        }

        func setPrimary(connectionId: String, userId: String) async throws {
            setPrimaryCalls.append(connectionId)
            connections = connections.map {
                RemoteMarketplaceConnection(
                    id: $0.id, accountHandle: $0.accountHandle, label: $0.label,
                    isPrimary: $0.id == connectionId, isActive: $0.isActive
                )
            }
        }
    }
}
