import XCTest
@testable import GradeThreadCore

/// US-1995: the orchestration around backwards title sync. Mirrors
/// src/lib/__tests__/title-sync-patch.test.ts case for case, because the patch
/// decisions (refuse ebay-origin, move both variants, flag hand-edited/live) are
/// the half that was never shared and so only ever ran on one surface.
final class TitleSyncPatchTests: XCTestCase {

    private let brandChange = [TitleSync.FieldChange(field: "brand", from: "Patagonia", to: "Arc'teryx")]

    func test_substitutesTheChangedFieldIntoTheTitle() {
        let patch = TitleSync.buildTitleSyncPatch(.init(
            baseTitle: "Patagonia Better Sweater Fleece Jacket",
            changes: brandChange
        ))
        XCTAssertEqual(patch.listingTitle, "Arc'teryx Better Sweater Fleece Jacket")
        XCTAssertNil(patch.needsReview)
    }

    func test_refusesToTouchAnEbayOriginListing() {
        // eBay owns that listing's title. Writing it would break the sync
        // contract, and eBay re-asserts its own value on the next pull anyway.
        let patch = TitleSync.buildTitleSyncPatch(.init(
            baseTitle: "Patagonia Better Sweater Fleece Jacket",
            changes: brandChange,
            listingOrigin: "ebay"
        ))
        XCTAssertTrue(patch.isEmpty)
    }

    func test_movesBothABVariants() {
        // A stale brand in variant B is the same bug, just less visible.
        let patch = TitleSync.buildTitleSyncPatch(.init(
            baseTitle: "Patagonia Fleece Jacket",
            variantTitles: ["Patagonia Fleece Jacket", "Patagonia Fleece Jacket Navy Medium"],
            changes: brandChange
        ))
        let expected: [String?]? = [
            "Arc'teryx Fleece Jacket",
            "Arc'teryx Fleece Jacket Navy Medium",
        ]
        XCTAssertEqual(patch.variantTitles, expected)
    }

    func test_leavesATitlelessVariantEntryUntouched() {
        // A variant with no string title comes back nil so the caller can leave
        // the jsonb entry exactly as it found it, rather than inventing a title.
        let patch = TitleSync.buildTitleSyncPatch(.init(
            baseTitle: "Patagonia Fleece Jacket",
            variantTitles: [nil, nil, "Patagonia Tee"],
            changes: brandChange
        ))
        let expected: [String?]? = [nil, nil, "Arc'teryx Tee"]
        XCTAssertEqual(patch.variantTitles, expected)
    }

    func test_flagsAHandEditedTitleForReview() {
        // The seller chose those words. Substitute, but surface the diff.
        let patch = TitleSync.buildTitleSyncPatch(.init(
            baseTitle: "Patagonia Fleece Jacket - RARE vintage colourway",
            changes: brandChange,
            snapshotTitle: "Patagonia Better Sweater Fleece Jacket"
        ))
        XCTAssertEqual(patch.listingTitle?.contains("Arc'teryx"), true)
        XCTAssertEqual(patch.needsReview, true)
    }

    func test_doesNotFlagWhenTheTitleStillMatchesTheAISnapshot() {
        let patch = TitleSync.buildTitleSyncPatch(.init(
            baseTitle: "Patagonia Better Sweater Fleece Jacket",
            changes: brandChange,
            snapshotTitle: "Patagonia Better Sweater Fleece Jacket"
        ))
        XCTAssertEqual(patch.listingTitle?.contains("Arc'teryx"), true)
        XCTAssertNil(patch.needsReview)
    }

    func test_flagsALiveListing() {
        // Buyers are already reading that title.
        let patch = TitleSync.buildTitleSyncPatch(.init(
            baseTitle: "Patagonia Better Sweater Fleece Jacket",
            changes: brandChange,
            snapshotTitle: "Patagonia Better Sweater Fleece Jacket",
            isLive: true
        ))
        XCTAssertEqual(patch.needsReview, true)
    }

    func test_returnsAnEmptyPatchWhenNothingWouldChange() {
        // Callers skip the write on an empty patch, so these must not produce a
        // no-op UPDATE that dirties updated_at on every save.
        XCTAssertTrue(TitleSync.buildTitleSyncPatch(
            .init(baseTitle: "Nike Tee", changes: brandChange)
        ).isEmpty)
        XCTAssertTrue(TitleSync.buildTitleSyncPatch(
            .init(baseTitle: "Patagonia Tee", changes: [])
        ).isEmpty)
        XCTAssertTrue(TitleSync.buildTitleSyncPatch(
            .init(baseTitle: "", changes: brandChange)
        ).isEmpty)
        XCTAssertTrue(TitleSync.buildTitleSyncPatch(
            .init(baseTitle: nil, changes: brandChange)
        ).isEmpty)
    }

    func test_doesNotMistakeAPureRetrimForASubstitution() {
        // syncTitle re-trims to the 80-char cap. An over-long title whose only
        // change is losing its tail must not be written back as if a field moved.
        let long = "Nike " + String(repeating: "x", count: 120)
        XCTAssertTrue(TitleSync.buildTitleSyncPatch(
            .init(baseTitle: long, changes: brandChange)
        ).isEmpty)
    }
}
