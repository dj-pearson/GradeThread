import XCTest
@testable import GradeThread

/// US-815 — pure pipeline auto-advance + prep-checklist derivation.
final class ItemWorkflowTests: XCTestCase {

    // MARK: - earnedStatus

    func test_earnedStatus_brandNewItem_isCataloged() {
        XCTAssertEqual(ItemWorkflow.earnedStatus(.init()), "cataloged")
    }

    func test_earnedStatus_measurementsOnly_isMeasured() {
        XCTAssertEqual(
            ItemWorkflow.earnedStatus(.init(hasMeasurements: true)),
            "measured")
    }

    func test_earnedStatus_requiredPhotos_isPhotographed() {
        // Photos outrank measurements regardless of whether measurements exist.
        XCTAssertEqual(
            ItemWorkflow.earnedStatus(.init(hasMeasurements: false, hasRequiredPhotos: true)),
            "photographed")
        XCTAssertEqual(
            ItemWorkflow.earnedStatus(.init(hasMeasurements: true, hasRequiredPhotos: true)),
            "photographed")
    }

    func test_earnedStatus_targetPrice_isComped() {
        XCTAssertEqual(
            ItemWorkflow.earnedStatus(.init(hasTargetPrice: true)),
            "comped")
    }

    func test_earnedStatus_draftListing_isDrafted() {
        XCTAssertEqual(
            ItemWorkflow.earnedStatus(.init(hasDraftListing: true)),
            "drafted")
    }

    func test_earnedStatus_neverGatesOnGrade() {
        // Grading is optional — a graded item with no other work earns nothing
        // past cataloged.
        XCTAssertEqual(
            ItemWorkflow.earnedStatus(.init(hasGrade: true)),
            "cataloged")
    }

    // MARK: - resolveStatus (auto-advance)

    func test_resolve_savingMeasurements_advancesEarlyItemToMeasured() {
        // AC: an item earlier in the pipeline advances to "measured" once it has
        // measurements.
        let resolved = ItemWorkflow.resolveStatus(
            current: "cataloged",
            selected: "cataloged",
            facts: .init(hasMeasurements: true))
        XCTAssertEqual(resolved, "measured")
    }

    func test_resolve_addingRequiredPhotos_advancesToPhotographed() {
        // AC: adding the required photos advances to "photographed".
        let resolved = ItemWorkflow.resolveStatus(
            current: "measured",
            selected: "measured",
            facts: .init(hasMeasurements: true, hasRequiredPhotos: true))
        XCTAssertEqual(resolved, "photographed")
    }

    func test_resolve_neverRegressesALaterStatus() {
        // AC: a later status is never pulled backward by an earlier earned stage.
        // Item is already "comped" but only has measurements — must stay comped.
        let resolved = ItemWorkflow.resolveStatus(
            current: "comped",
            selected: "comped",
            facts: .init(hasMeasurements: true))
        XCTAssertEqual(resolved, "comped")
    }

    func test_resolve_doesNotRegressTerminalStatus() {
        // A sold item whose work would only earn "drafted" stays sold.
        let resolved = ItemWorkflow.resolveStatus(
            current: "sold",
            selected: "sold",
            facts: .init(hasRequiredPhotos: true, hasTargetPrice: true, hasDraftListing: true))
        XCTAssertEqual(resolved, "sold")
    }

    func test_resolve_manualNonPrepPickWinsOutright() {
        // The user explicitly setting a side-track status wins even when prep
        // work would earn a different prep stage.
        let resolved = ItemWorkflow.resolveStatus(
            current: "photographed",
            selected: "keeping",
            facts: .init(hasMeasurements: true, hasRequiredPhotos: true, hasTargetPrice: true))
        XCTAssertEqual(resolved, "keeping")
    }

    func test_resolve_manualForwardPickWinsOverEarnedWhenFurther() {
        // User jumps an item to "drafted" by hand even though work only earned
        // "photographed" — the furthest of the three wins.
        let resolved = ItemWorkflow.resolveStatus(
            current: "cataloged",
            selected: "drafted",
            facts: .init(hasRequiredPhotos: true))
        XCTAssertEqual(resolved, "drafted")
    }

    func test_resolve_earnedWinsOverEarlierManualPick() {
        // User left the picker at "cataloged" but the work earned "comped".
        let resolved = ItemWorkflow.resolveStatus(
            current: "cataloged",
            selected: "cataloged",
            facts: .init(hasRequiredPhotos: true, hasTargetPrice: true))
        XCTAssertEqual(resolved, "comped")
    }

    // MARK: - Required-photo detection

    func test_hasRequiredPhotos_frontAndBackPresent() {
        // Only Front + Back are required (00306).
        XCTAssertTrue(ItemPrepChecklist.hasRequiredPhotos(
            photoTypes: ["front", "back"]))
        // Tag + Detail are optional — front+back alone is enough, and extras
        // don't break it.
        XCTAssertTrue(ItemPrepChecklist.hasRequiredPhotos(
            photoTypes: ["front", "back", "tag", "detail", "defect", "flatlay"]))
    }

    func test_hasRequiredPhotos_missingFrontOrBack() {
        // Missing back → not satisfied, even with tag/detail present.
        XCTAssertFalse(ItemPrepChecklist.hasRequiredPhotos(
            photoTypes: ["front", "tag", "detail"]))
        XCTAssertFalse(ItemPrepChecklist.hasRequiredPhotos(photoTypes: []))
    }

    // MARK: - advanced(current:to:) — US-2818 post-AI drafting

    func test_advanced_movesAPrepItemForward() {
        XCTAssertEqual(
            ItemWorkflow.advanced(current: "photographed", to: ItemWorkflow.aiDraftedStatus),
            "drafted")
        XCTAssertEqual(
            ItemWorkflow.advanced(current: "cataloged", to: "drafted"), "drafted")
    }

    func test_advanced_refusesToRepeatOrRegress() {
        // Already there.
        XCTAssertNil(ItemWorkflow.advanced(current: "drafted", to: "drafted"))
        // Further along the prep pipeline than the target.
        XCTAssertNil(ItemWorkflow.advanced(current: "comped", to: "measured"))
    }

    /// The AI extract runs in the background, so the seller may have listed or
    /// sold the item while it ran. Stepping one of those back to "drafted" would
    /// unlist a live listing in every view that reads status.
    func test_advanced_neverTouchesAnItemThatLeftThePrepPipeline() {
        for status in ["listed", "sold", "shipped", "completed", "archived", "keeping"] {
            XCTAssertNil(
                ItemWorkflow.advanced(current: status, to: "drafted"),
                status)
        }
    }

    /// Once "drafted" is set, nothing in the canvas's own auto-advance walks it
    /// back — resolveStatus takes the furthest of current / picked / earned, and
    /// the earned status of an item with no listing row is only "photographed".
    func test_resolveStatus_doesNotRegressAnAiDraftedItem() {
        let facts = ItemWorkflow.Facts(hasRequiredPhotos: true)
        XCTAssertEqual(
            ItemWorkflow.resolveStatus(current: "drafted", selected: "drafted", facts: facts),
            "drafted")
    }

    // MARK: - Checklist rendering (AC4)

    func test_checklist_brandNewItem_allIncomplete() {
        let rows = ItemPrepChecklist.rows(facts: .init())
        XCTAssertEqual(rows.count, 5)
        XCTAssertTrue(rows.allSatisfy { !$0.done })
        XCTAssertEqual(ItemPrepChecklist.completedRequired(facts: .init()), 0)
        XCTAssertEqual(ItemPrepChecklist.totalRequired(facts: .init()), 4)
    }

    func test_checklist_fullyPreppedItem_allComplete() {
        let facts = ItemWorkflow.Facts(
            hasMeasurements: true,
            hasRequiredPhotos: true,
            hasTargetPrice: true,
            hasGrade: true,
            hasDraftListing: true)
        let rows = ItemPrepChecklist.rows(facts: facts)
        XCTAssertTrue(rows.allSatisfy { $0.done })
        XCTAssertEqual(ItemPrepChecklist.completedRequired(facts: facts), 4)
    }

    func test_checklist_gradeRowIsOptional() {
        let gradeRow = ItemPrepChecklist.rows(facts: .init()).first { $0.step == .grade }
        XCTAssertEqual(gradeRow?.optional, true)
        // Grade completion never counts toward required progress.
        let onlyGraded = ItemWorkflow.Facts(hasGrade: true)
        XCTAssertEqual(ItemPrepChecklist.completedRequired(facts: onlyGraded), 0)
    }
}
