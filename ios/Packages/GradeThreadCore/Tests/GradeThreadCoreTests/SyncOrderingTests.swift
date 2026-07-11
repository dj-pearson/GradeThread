import XCTest
@testable import GradeThreadCore

/// Pure sync ordering primitives — run on Linux (`swift test`, no Mac).
final class SyncOrderingTests: XCTestCase {

    // MARK: - US-1493: scope-epoch guard (workspace switch / sign-out mid-pull)

    func test_pullResultApplies_sameEpoch_applies() {
        XCTAssertTrue(SyncOrdering.pullResultApplies(startEpoch: 3, currentEpoch: 3))
    }

    func test_pullResultApplies_changedEpoch_discards() {
        // Any change — either direction — is a discard.
        XCTAssertFalse(SyncOrdering.pullResultApplies(startEpoch: 3, currentEpoch: 4))
        XCTAssertFalse(SyncOrdering.pullResultApplies(startEpoch: 4, currentEpoch: 3))
    }

    // MARK: - US-1210: drop-safe watermark cursor

    func test_safeCursor_keepsCursorBehindDroppedLowRow() {
        // A row that failed to decode sits at an EARLIER timestamp than rows that
        // decoded cleanly. The watermark must not jump past it, so the safe cursor
        // is the latest decoded value strictly before the dropped one.
        let cursor = SyncOrdering.safeCursor(
            decodedCursors: ["2026-06-01T00:00:00Z", "2026-06-03T00:00:00Z"],
            droppedCursors: ["2026-06-02T00:00:00Z"]
        )
        XCTAssertEqual(cursor, "2026-06-01T00:00:00Z")
    }

    func test_safeCursor_noDrops_advancesToMax() {
        let cursor = SyncOrdering.safeCursor(
            decodedCursors: ["2026-06-01T00:00:00Z", "2026-06-03T00:00:00Z"],
            droppedCursors: []
        )
        XCTAssertEqual(cursor, "2026-06-03T00:00:00Z")
    }

    func test_safeCursor_droppedBeforeAllDecoded_doesNotAdvance() {
        // Every decoded row sits at/after the dropped row → no safe value to move
        // to without skipping it → hold the watermark (nil = don't advance).
        let cursor = SyncOrdering.safeCursor(
            decodedCursors: ["2026-06-05T00:00:00Z"],
            droppedCursors: ["2026-06-04T00:00:00Z"]
        )
        XCTAssertNil(cursor)
    }

    func test_safeCursor_allEmpty_isNil() {
        XCTAssertNil(SyncOrdering.safeCursor(decodedCursors: [], droppedCursors: []))
    }

    func test_safeCursor_multipleDrops_usesEarliest() {
        // Two dropped rows; the earliest (2026-06-02) is the barrier, so only the
        // decoded 2026-06-01 is safe — 2026-06-03 would skip the 2026-06-02 drop.
        let cursor = SyncOrdering.safeCursor(
            decodedCursors: ["2026-06-01T00:00:00Z", "2026-06-03T00:00:00Z"],
            droppedCursors: ["2026-06-04T00:00:00Z", "2026-06-02T00:00:00Z"]
        )
        XCTAssertEqual(cursor, "2026-06-01T00:00:00Z")
    }
}
