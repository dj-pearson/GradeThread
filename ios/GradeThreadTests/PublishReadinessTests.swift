import XCTest
@testable import GradeThread

/// US-683 — publish-readiness signal used by the canvas banner + inventory row.
final class PublishReadinessTests: XCTestCase {

    func test_ready_whenTitlePhotoPriceAndPublishableStatus() {
        XCTAssertTrue(PublishReadiness.isReady(
            title: "Patagonia Better Sweater",
            hasPhotos: true,
            targetPrice: 45,
            status: "photographed"))
    }

    func test_blockers_listsMissingPieces() {
        let blockers = PublishReadiness.blockers(
            title: "Untitled item",
            hasPhotos: false,
            targetPrice: nil,
            status: "cataloged")
        XCTAssertEqual(blockers, ["Add a title", "Add at least one photo", "Set a list price"])
    }

    func test_untitledItem_isABlocker() {
        XCTAssertTrue(PublishReadiness.blockers(
            title: "untitled ITEM", hasPhotos: true, targetPrice: 10, status: "comped")
            .contains("Add a title"))
    }

    func test_zeroPrice_isABlocker() {
        XCTAssertTrue(PublishReadiness.blockers(
            title: "Jacket", hasPhotos: true, targetPrice: 0, status: "comped")
            .contains("Set a list price"))
    }

    func test_notReady_whenStatusNotPublishable() {
        // Even a complete item isn't "ready to list" once sold/listed.
        XCTAssertFalse(PublishReadiness.isReady(
            title: "Jacket", hasPhotos: true, targetPrice: 30, status: "sold"))
        XCTAssertFalse(PublishReadiness.isPublishable(status: "sold"))
    }
}
