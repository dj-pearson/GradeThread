import XCTest
@testable import GradeThread

@MainActor
final class BulkActionTests: XCTestCase {

    // MARK: - BulkAction.actions(for:) stage mapping

    func test_actions_unlisted_includesGradeAndCreateDraft() {
        // US-1130: the dead `.aiEnrich` case was removed entirely (it was a
        // permanent stub never surfaced in any action set), so there's nothing
        // to assert against anymore — just confirm the real unlisted actions.
        let actions = BulkAction.actions(for: .unlisted)
        XCTAssertTrue(actions.contains(.grade))
        XCTAssertTrue(actions.contains(.createDraft))
        XCTAssertTrue(actions.contains(.exportCSV))
        XCTAssertFalse(actions.contains(.endListing))
    }

    func test_actions_active_includesDropPriceAndEndListing() {
        let actions = BulkAction.actions(for: .active)
        XCTAssertTrue(actions.contains(.endListing))
        XCTAssertTrue(actions.contains(.dropPrice(percent: 10)))
        XCTAssertFalse(actions.contains(.createDraft))
        XCTAssertFalse(actions.contains(.markShipped))
    }

    func test_actions_sold_includesMarkShipped() {
        let actions = BulkAction.actions(for: .sold)
        XCTAssertTrue(actions.contains(.markShipped))
        XCTAssertFalse(actions.contains(.endListing))
    }

    func test_actions_unlisted_includesPublish() {
        // US-680: bulk publish to eBay is offered from the pre-list stage.
        XCTAssertTrue(BulkAction.actions(for: .unlisted).contains(.publish))
        XCTAssertFalse(BulkAction.actions(for: .sold).contains(.publish))
    }

    func test_publish_surface() {
        XCTAssertEqual(BulkAction.publish.id, "publish")
        XCTAssertEqual(BulkAction.publish.label, "Publish")
        XCTAssertFalse(BulkAction.publish.isDestructive)
        XCTAssertEqual(BulkAction.publish.confirmationTitle(count: 3), "Publish 3 items to eBay?")
    }

    func test_actions_all_restrictedToExport() {
        // Mixed-status selection only allows the uniform action so a
        // careless bulk doesn't corrupt half the rows.
        XCTAssertEqual(BulkAction.actions(for: .all), [.exportCSV])
    }

    func test_actions_shippedAndReturned_exportOnly() {
        XCTAssertEqual(BulkAction.actions(for: .shipped), [.exportCSV])
        XCTAssertEqual(BulkAction.actions(for: .returned), [.exportCSV])
    }

    // MARK: - BulkAction surface

    func test_endListing_isDestructive() {
        XCTAssertTrue(BulkAction.endListing.isDestructive)
        XCTAssertFalse(BulkAction.createDraft.isDestructive)
        XCTAssertFalse(BulkAction.markShipped.isDestructive)
        XCTAssertFalse(BulkAction.dropPrice(percent: 10).isDestructive)
    }

    func test_confirmationTitle_singularPlural() {
        XCTAssertEqual(BulkAction.markShipped.confirmationTitle(count: 1),
                       "Mark 1 item as shipped?")
        XCTAssertEqual(BulkAction.markShipped.confirmationTitle(count: 3),
                       "Mark 3 items as shipped?")
        XCTAssertEqual(BulkAction.dropPrice(percent: 15).confirmationTitle(count: 2),
                       "Drop price -15% on 2 items?")
    }

    func test_id_uniquePerDropPercent() {
        // Different percent levels need distinct ids so the SwiftUI
        // ForEach can keep them straight if we ever surface a multi-step
        // picker like the web ('-5% / -10% / -15%').
        XCTAssertNotEqual(BulkAction.dropPrice(percent: 5).id,
                          BulkAction.dropPrice(percent: 10).id)
    }

    // MARK: - BulkActionResult

    func test_summary_allSucceeded() {
        let result = BulkActionResult(
            action: .createDraft, succeeded: 3, failures: []
        )
        XCTAssertEqual(result.summary, "Updated 3 items.")
        XCTAssertEqual(result.total, 3)
    }

    func test_summary_singularGrammar() {
        let result = BulkActionResult(
            action: .markShipped, succeeded: 1, failures: []
        )
        XCTAssertEqual(result.summary, "Updated 1 item.")
    }

    func test_summary_allFailed() {
        let result = BulkActionResult(
            action: .endListing,
            succeeded: 0,
            failures: [.init(itemId: "a", message: "x"), .init(itemId: "b", message: "y")]
        )
        XCTAssertEqual(result.summary, "All 2 items failed.")
    }

    func test_summary_partialSuccess() {
        let result = BulkActionResult(
            action: .createDraft,
            succeeded: 2,
            failures: [.init(itemId: "x", message: "boom")]
        )
        XCTAssertEqual(result.summary, "Updated 2 of 3 items; 1 failed.")
    }

    // MARK: - Price-drop math (BulkActionExecutor.droppedPrice)

    func test_droppedPrice_basicReduction() {
        XCTAssertEqual(BulkActionExecutor.droppedPrice(from: 50, percent: 10), 45, accuracy: 0.001)
        XCTAssertEqual(BulkActionExecutor.droppedPrice(from: 100, percent: 10), 90, accuracy: 0.001)
        XCTAssertEqual(BulkActionExecutor.droppedPrice(from: 20, percent: 15), 17, accuracy: 0.001)
    }

    func test_droppedPrice_roundsToWholeCents() {
        // 33.33 × 0.9 = 29.997 → 30.00
        XCTAssertEqual(BulkActionExecutor.droppedPrice(from: 33.33, percent: 10), 30.0, accuracy: 0.001)
    }

    func test_droppedPrice_floorsAtOneDollar() {
        // A cheap item dropped below $1 clamps to $1 rather than going to
        // an invalid sub-dollar (or zero) price.
        XCTAssertEqual(BulkActionExecutor.droppedPrice(from: 1.05, percent: 10), 1.0, accuracy: 0.001)
        XCTAssertEqual(BulkActionExecutor.droppedPrice(from: 0.50, percent: 10), 1.0, accuracy: 0.001)
    }

    func test_droppedPrice_zeroPercent_isUnchanged() {
        XCTAssertEqual(BulkActionExecutor.droppedPrice(from: 42.50, percent: 0), 42.50, accuracy: 0.001)
    }

    func test_droppedPrice_extremePercent_clampsMultiplierNotNegative() {
        // 100% off would be free; the multiplier floors at 0.01 and the
        // result then floors at $1.
        XCTAssertEqual(BulkActionExecutor.droppedPrice(from: 50, percent: 100), 1.0, accuracy: 0.001)
    }

    // MARK: - US-756 retry-only-failed

    func test_failedItemIdsToRetry_isExactlyTheFailedSet() {
        let result = BulkActionResult(
            action: .publish,
            succeeded: 2,
            failures: [.init(itemId: "x", message: "boom"),
                       .init(itemId: "y", message: "nope")]
        )
        // Only the failed ids — the 2 that succeeded are never re-run.
        XCTAssertEqual(InventoryListView.failedItemIdsToRetry(result), ["x", "y"])
    }

    func test_failedItemIdsToRetry_emptyWhenNoFailures() {
        let result = BulkActionResult(action: .createDraft, succeeded: 3, failures: [])
        XCTAssertTrue(InventoryListView.failedItemIdsToRetry(result).isEmpty)
    }

    func test_isRetryable_excludesExportAndGrade() {
        // Export can't fail and grade runs in its own sheet, so neither offers
        // a retry; the server-backed actions all do.
        XCTAssertFalse(InventoryListView.isRetryable(.exportCSV))
        XCTAssertFalse(InventoryListView.isRetryable(.grade))
        XCTAssertTrue(InventoryListView.isRetryable(.publish))
        XCTAssertTrue(InventoryListView.isRetryable(.endListing))
        XCTAssertTrue(InventoryListView.isRetryable(.dropPrice(percent: 10)))
        XCTAssertTrue(InventoryListView.isRetryable(.markShipped))
    }

    // MARK: - BulkSelectionStore

    func test_selectionStore_toggleEditing_clearsSelectionOnDisable() {
        let store = BulkSelectionStore()
        store.toggleEditing()
        XCTAssertTrue(store.isEditing)
        store.selected.insert("a")
        store.selected.insert("b")
        XCTAssertEqual(store.count, 2)

        store.toggleEditing()
        XCTAssertFalse(store.isEditing)
        XCTAssertEqual(store.count, 0, "disabling edit mode must wipe selection")
    }

    func test_selectionStore_toggleId_flipsMembership() {
        let store = BulkSelectionStore()
        XCTAssertFalse(store.contains("x"))
        store.toggle("x")
        XCTAssertTrue(store.contains("x"))
        store.toggle("x")
        XCTAssertFalse(store.contains("x"))
    }

    func test_selectionStore_clear_emptiesSelection() {
        let store = BulkSelectionStore()
        store.selected = ["a", "b", "c"]
        XCTAssertEqual(store.count, 3)
        store.clear()
        XCTAssertTrue(store.isEmpty)
    }
}
