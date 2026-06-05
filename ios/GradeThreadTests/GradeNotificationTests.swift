import XCTest
@testable import GradeThread

/// Pure newly-graded diffing + the grade-ready deep-link mapping.
final class GradeNotificationTests: XCTestCase {

    // MARK: - Diff

    func test_newlyGraded_returnsIdsNotSeenBefore() {
        let result = GradeNotificationDiff.newlyGraded(
            current: ["a", "b", "c"], lastSeen: ["a"]
        )
        XCTAssertEqual(result, ["b", "c"])
    }

    func test_firstRun_lastSeenNil_returnsEmpty() {
        // A fresh install must not ping for the whole back-catalog of grades.
        XCTAssertTrue(
            GradeNotificationDiff.newlyGraded(current: ["a", "b"], lastSeen: nil).isEmpty
        )
    }

    func test_nothingNew_returnsEmpty() {
        XCTAssertTrue(
            GradeNotificationDiff.newlyGraded(current: ["a"], lastSeen: ["a", "b"]).isEmpty
        )
    }

    func test_emptyCurrent_returnsEmpty() {
        XCTAssertTrue(
            GradeNotificationDiff.newlyGraded(current: [], lastSeen: ["a"]).isEmpty
        )
    }

    // MARK: - Deep-link mapping

    func test_gradeReadyCategory_mapsToInventoryItem() {
        let route = DeepLinkRoute.from(
            category: NotificationCategoryID.gradeReady.rawValue,
            userInfo: ["inventory_item_id": "item-1"]
        )
        XCTAssertEqual(route, .inventoryItem(id: "item-1"))
    }

    func test_gradeReadyCategory_withoutItemId_isNil() {
        XCTAssertNil(
            DeepLinkRoute.from(category: NotificationCategoryID.gradeReady.rawValue, userInfo: [:])
        )
    }

    func test_unknownCategory_isNil() {
        XCTAssertNil(DeepLinkRoute.from(category: "something.else", userInfo: [:]))
    }
}
