import XCTest
@testable import GradeThread

final class PhotoOrderingTests: XCTestCase {

    private struct FakePhoto: PhotoOrderable {
        let id: String
        let currentSortOrder: Int
    }

    // MARK: - changedSortOrders

    func test_changedSortOrders_fullReorder_reportsEveryMovedRow() {
        // Current [a:0, b:1, c:2] reordered to [c, a, b].
        let ordered = [
            FakePhoto(id: "c", currentSortOrder: 2),
            FakePhoto(id: "a", currentSortOrder: 0),
            FakePhoto(id: "b", currentSortOrder: 1),
        ]
        let changes = PhotoOrdering.changedSortOrders(ordered)
        let dict = Dictionary(uniqueKeysWithValues: changes.map { ($0.id, $0.sortOrder) })
        XCTAssertEqual(dict, ["c": 0, "a": 1, "b": 2])
    }

    func test_changedSortOrders_alreadyInOrder_reportsNothing() {
        let ordered = [
            FakePhoto(id: "a", currentSortOrder: 0),
            FakePhoto(id: "b", currentSortOrder: 1),
        ]
        XCTAssertTrue(PhotoOrdering.changedSortOrders(ordered).isEmpty)
    }

    func test_changedSortOrders_partialChange_reportsOnlyMovedRows() {
        // [a:0, c:2, b:1] — a stays at 0, only c and b move.
        let ordered = [
            FakePhoto(id: "a", currentSortOrder: 0),
            FakePhoto(id: "c", currentSortOrder: 2),
            FakePhoto(id: "b", currentSortOrder: 1),
        ]
        let dict = Dictionary(
            uniqueKeysWithValues: PhotoOrdering.changedSortOrders(ordered).map { ($0.id, $0.sortOrder) }
        )
        XCTAssertNil(dict["a"])
        XCTAssertEqual(dict["c"], 1)
        XCTAssertEqual(dict["b"], 2)
    }

    // MARK: - movedToCover

    func test_movedToCover_movesElementToFront() {
        let ordered = [
            FakePhoto(id: "a", currentSortOrder: 0),
            FakePhoto(id: "b", currentSortOrder: 1),
            FakePhoto(id: "c", currentSortOrder: 2),
        ]
        XCTAssertEqual(PhotoOrdering.movedToCover(ordered, from: 2).map(\.id), ["c", "a", "b"])
    }

    func test_movedToCover_noopWhenAlreadyCover() {
        let ordered = [
            FakePhoto(id: "a", currentSortOrder: 0),
            FakePhoto(id: "b", currentSortOrder: 1),
        ]
        XCTAssertEqual(PhotoOrdering.movedToCover(ordered, from: 0).map(\.id), ["a", "b"])
    }

    func test_movedToCover_noopWhenOutOfRange() {
        let ordered = [FakePhoto(id: "a", currentSortOrder: 0)]
        XCTAssertEqual(PhotoOrdering.movedToCover(ordered, from: 5).map(\.id), ["a"])
    }
}
