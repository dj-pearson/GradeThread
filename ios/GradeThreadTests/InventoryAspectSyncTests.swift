import XCTest
@testable import GradeThread

/// US-2274 AC5: what an item-column edit is allowed to do to
/// `listings.item_specifics_override`.
///
/// That map is the one publish and revise read FIRST, so it is the store where a
/// wrong write is expensive. The rule this pins is narrow and deliberate:
/// **the projection can only ever SET a value, never remove one.**
///
/// The story's own 2026-08-03 warning is why. A clear-on-blank projection written
/// into this store re-opens the bug fixed in `ea9e27a2`: a blank Brand column
/// beside an AI- or hand-typed Brand aspect is the ordinary state of an
/// iOS-created item, so clearing it there produced "Fill required eBay specifics
/// in the composer: Brand" on a listing that visibly had Brand. Web reached the
/// same conclusion independently - `projectColumnAspectsForSpec` bails on a blank
/// column so it stays overwrite-only.
final class InventoryAspectSyncTests: XCTestCase {

    // MARK: - It can only add

    func test_columnOwnedAspect_isProjected() {
        let merge = InventoryAspectSync.listingOverrideMerge(
            columnOwned: ["Brand", "Size"],
            filled: ["Brand": ["Levi's"], "Size": ["M"], "Pattern": ["Plaid"]]
        )
        XCTAssertEqual(merge, ["Brand": ["Levi's"], "Size": ["M"]])
    }

    func test_aspectTheColumnDoesNotOwn_isLeftAlone() {
        // Department, Pattern and friends belong to the seller or the AI. The
        // column projection must not express an opinion about them at all -
        // returning them here would overwrite a hand-typed value on merge.
        let merge = InventoryAspectSync.listingOverrideMerge(
            columnOwned: ["Brand"],
            filled: ["Brand": ["Levi's"], "Department": ["Men"], "Pattern": ["Plaid"]]
        )
        XCTAssertEqual(merge, ["Brand": ["Levi's"]])
        XCTAssertNil(merge["Department"])
    }

    // MARK: - It can never remove

    func test_aClearedColumnRemovesNothing() {
        // THE ea9e27a2 CASE. The server says the seller blanked Brand; the
        // projection still must not carry a removal into the override store,
        // because a blank column cannot be told apart from a never-populated one
        // and the aspect may hold a value the seller typed in the editor.
        let merge = InventoryAspectSync.listingOverrideMerge(
            columnOwned: [],
            filled: ["Size": ["M"]]
        )
        XCTAssertTrue(merge.isEmpty)
    }

    func test_anEmptyValueIsNotProjectedAsAnEmptyAspect() {
        // Present-and-empty is not the same as absent. Writing [] or [""] into
        // the override map is a DELETION dressed as a value: publish reads that
        // map first and would find the required specific missing.
        let merge = InventoryAspectSync.listingOverrideMerge(
            columnOwned: ["Brand", "Color"],
            filled: ["Brand": [], "Color": [""]]
        )
        XCTAssertTrue(merge.isEmpty)
    }

    func test_ownedButAbsentFromTheReconciledResult_isSkipped() {
        // The server can name a column owner that reconciliation then dropped
        // (not expressible for this category). Projecting it would write a key
        // with no value.
        let merge = InventoryAspectSync.listingOverrideMerge(
            columnOwned: ["Brand", "Style"],
            filled: ["Brand": ["Levi's"]]
        )
        XCTAssertEqual(merge, ["Brand": ["Levi's"]])
    }

    /// The property, stated once so a future edit has to break it deliberately:
    /// every key the merge returns carries at least one non-empty value.
    func test_theMergeIsAlwaysAdditive() {
        let merge = InventoryAspectSync.listingOverrideMerge(
            columnOwned: ["Brand", "Size", "Color", "Material", "Style"],
            filled: [
                "Brand": ["Levi's"],
                "Size": [],
                "Color": [""],
                "Material": ["Cotton", ""],
            ]
        )
        for (name, values) in merge {
            XCTAssertFalse(values.isEmpty, "\(name) projected with no values")
            XCTAssertFalse(
                values.contains(where: { $0.isEmpty }),
                "\(name) projected an empty string, which publish reads as absent"
            )
        }
        XCTAssertEqual(merge["Material"], ["Cotton"])
    }
}
