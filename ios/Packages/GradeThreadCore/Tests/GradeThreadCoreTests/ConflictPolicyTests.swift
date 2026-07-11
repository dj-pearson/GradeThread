import XCTest
@testable import GradeThreadCore

/// Field-level merge policy tests. Moved out of the app's SyncTests so they RUN
/// ON LINUX (`swift test`) — no SwiftData / simulator needed. This is the proof
/// that pure logic extracted into GradeThreadCore is testable without a Mac.
final class ConflictPolicyTests: XCTestCase {

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

    // MARK: - Listing provenance (US-1086)

    func test_ebayOwnedListingField_ebayOriginated_serverAlwaysWins() {
        // eBay-originated: server wins even when the local row is dirty.
        let result = ConflictPolicy.resolveEbayOwnedListingField(
            local: "My Title", server: "eBay Title",
            hasLocalChanges: true, listingOrigin: "ebay"
        )
        XCTAssertEqual(result, "eBay Title")
    }

    func test_ebayOwnedListingField_gtOriginated_clientWinsWhenDirty() {
        // GradeThread-originated: local wins while dirty.
        let result = ConflictPolicy.resolveEbayOwnedListingField(
            local: "My Edit", server: "eBay Value",
            hasLocalChanges: true, listingOrigin: "gradethread"
        )
        XCTAssertEqual(result, "My Edit")
    }

    func test_ebayOwnedListingField_gtOriginated_serverWinsWhenClean() {
        // GradeThread-originated clean row defers to server.
        let result = ConflictPolicy.resolveEbayOwnedListingField(
            local: "Stale", server: "Server Updated",
            hasLocalChanges: false, listingOrigin: "gradethread"
        )
        XCTAssertEqual(result, "Server Updated")
    }

    func test_ebayOwnedListingField_nilOrigin_treatedAsGradethread() {
        // Nil origin (legacy row) falls through to userOwned rules, not locked.
        let result = ConflictPolicy.resolveEbayOwnedListingField(
            local: "Local Edit", server: "Server",
            hasLocalChanges: true, listingOrigin: nil
        )
        XCTAssertEqual(result, "Local Edit")
    }
}
