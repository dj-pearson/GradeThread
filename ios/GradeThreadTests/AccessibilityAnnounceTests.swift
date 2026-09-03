import XCTest
@testable import GradeThread

/// US-701 / US-703 — covers the pure label/announcement builders behind the
/// accessibility wiring (the UIAccessibility.post side effects no-op without
/// VoiceOver and aren't unit-testable, but the strings they carry are).
@MainActor
final class AccessibilityAnnounceTests: XCTestCase {

    // MARK: - US-701 eBay sync announcements

    func test_ebaySync_completedAnnouncement_includesCounts() {
        let store = EbaySyncStore()
        let summary = EbaySyncSummary(listingsCount: 12, activeListingsCount: 9, salesCount: 3)
        let text = store.completionAnnouncement(.completed(summary))
        XCTAssertTrue(text.contains("12 listings"))
        XCTAssertTrue(text.contains("3 sales"))
    }

    func test_ebaySync_failureAnnouncement_includesMessage() {
        let store = EbaySyncStore()
        XCTAssertTrue(store.completionAnnouncement(.failed(message: "token expired"))
            .contains("token expired"))
        XCTAssertTrue(store.completionAnnouncement(.timedOut).lowercased().contains("timed out"))
    }

    // MARK: - US-703 Scout card composed label

    func test_scoutCard_accessibilitySummary_isComposedAndIncludesDeal() {
        let candidate = ScoutCandidate(
            itemId: "1",
            title: "Patagonia Better Sweater",
            imageUrl: nil,
            itemWebUrl: "https://ebay.com/itm/1",
            askingCents: 2500,
            shadowGrade: 8.0,
            gradeConfidence: 0.82,
            valueLowCents: 4000,
            valueMedianCents: 5000,
            valueHighCents: 6000,
            estMarginCents: 1800,
            estMarginPct: 0.72,
            underpriced: true,
            actionable: true,
            reason: "Priced below comparable condition",
            valueBasis: nil,
            url: nil)
        let summary = ScoutCandidateRow(candidate: candidate).accessibilitySummary

        XCTAssertTrue(summary.contains("Patagonia Better Sweater"))
        XCTAssertTrue(summary.contains("Deal"))
        XCTAssertTrue(summary.contains("shadow grade 8.0 out of 10"))
        XCTAssertTrue(summary.contains("82 percent confidence"))
        XCTAssertTrue(summary.contains("asking"))
        XCTAssertTrue(summary.contains("Priced below comparable condition"))
    }

    // MARK: - US-1021 pull-to-refresh failure announcement

    func test_refreshFailure_announcement_includesMessage() {
        let text = InventoryListView.refreshFailureAnnouncement("eBay token expired")
        XCTAssertTrue(text.lowercased().contains("refresh failed"))
        XCTAssertTrue(text.contains("eBay token expired"))
    }

    func test_refreshFailure_announcement_blankMessage_stillAnnouncesFailure() {
        let text = InventoryListView.refreshFailureAnnouncement("   ")
        XCTAssertEqual(text, "Refresh failed.")
    }

    func test_scoutCard_accessibilitySummary_marksUncertain() {
        let candidate = ScoutCandidate(
            itemId: "2", title: "Unknown jacket", imageUrl: nil, itemWebUrl: nil,
            askingCents: 1000, shadowGrade: nil, gradeConfidence: 0.4,
            valueLowCents: nil, valueMedianCents: nil, valueHighCents: nil,
            estMarginCents: nil, estMarginPct: nil,
            underpriced: false, actionable: false, reason: "Not enough comps",
            valueBasis: nil, url: nil)
        let summary = ScoutCandidateRow(candidate: candidate).accessibilitySummary
        XCTAssertTrue(summary.contains("uncertain"))
        XCTAssertFalse(summary.contains("Deal"))
    }
}
