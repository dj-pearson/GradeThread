import XCTest
@testable import GradeThread

/// Pure logic for the item-specifics editor: missing-required detection and the
/// AI suggestion merge (confidence floor, never-overwrite, single/multi,
/// selection-only filtering).
final class SpecificsEditorTests: XCTestCase {

    private func spec(
        _ name: String, _ usage: AspectSpec.Usage,
        selectionOnly: Bool = false, multi: Bool = false, allowed: [String] = []
    ) -> AspectSpec {
        AspectSpec(name: name, usage: usage, selectionOnly: selectionOnly,
                   multiSelect: multi, allowedValues: allowed)
    }

    func test_missingRequired_listsBlankRequiredOnly() {
        let specs = [spec("Brand", .required), spec("Size", .required), spec("Color", .recommended)]
        let values = ["Brand": ["Nike"], "Size": [""], "Color": []]
        XCTAssertEqual(SpecificsEditorModel.missingRequired(specs: specs, values: values), ["Size"])
    }

    func test_missingRequired_emptyWhenAllFilled() {
        let specs = [spec("Brand", .required)]
        XCTAssertTrue(
            SpecificsEditorModel.missingRequired(specs: specs, values: ["Brand": ["Nike"]]).isEmpty
        )
    }

    func test_merge_fillsBlanks_singleVsMulti() {
        let specs = [spec("Brand", .required), spec("Features", .optional, multi: true)]
        let sugg = [
            "Brand": AspectSuggestion(values: ["Nike", "Adidas"], confidence: 0.9, source: nil),
            "Features": AspectSuggestion(values: ["Waterproof", "Breathable"], confidence: 0.8, source: nil),
        ]
        let (values, filled) = SpecificsEditorModel.mergeAISuggestions(
            into: [:], suggestions: sugg, specs: specs, minConfidence: 0.6
        )
        XCTAssertEqual(values["Brand"], ["Nike"]) // single → first only
        XCTAssertEqual(values["Features"], ["Waterproof", "Breathable"]) // multi → all
        XCTAssertEqual(filled, ["Brand", "Features"])
    }

    func test_merge_skipsLowConfidence_andNeverOverwrites() {
        let specs = [spec("Brand", .required), spec("Color", .recommended)]
        let sugg = [
            "Brand": AspectSuggestion(values: ["Nike"], confidence: 0.4, source: nil), // below floor
            "Color": AspectSuggestion(values: ["Blue"], confidence: 0.9, source: nil),
        ]
        let (values, filled) = SpecificsEditorModel.mergeAISuggestions(
            into: ["Color": ["Red"]], suggestions: sugg, specs: specs, minConfidence: 0.6
        )
        XCTAssertNil(values["Brand"])              // skipped (low confidence)
        XCTAssertEqual(values["Color"], ["Red"])   // user value preserved
        XCTAssertTrue(filled.isEmpty)
    }

    func test_merge_selectionOnly_filtersToAllowedValues() {
        let specs = [spec("Size", .required, selectionOnly: true, allowed: ["9", "10"])]
        let sugg = ["Size": AspectSuggestion(values: ["11"], confidence: 0.9, source: nil)] // not allowed
        let (values, filled) = SpecificsEditorModel.mergeAISuggestions(
            into: [:], suggestions: sugg, specs: specs, minConfidence: 0.6
        )
        XCTAssertNil(values["Size"])
        XCTAssertTrue(filled.isEmpty)
    }

    func test_merge_unknownAspect_ignored() {
        let specs = [spec("Brand", .required)]
        let sugg = ["Mystery": AspectSuggestion(values: ["x"], confidence: 0.99, source: nil)]
        let (values, _) = SpecificsEditorModel.mergeAISuggestions(
            into: [:], suggestions: sugg, specs: specs, minConfidence: 0.6
        )
        XCTAssertTrue(values.isEmpty)
    }

    // MARK: - US-824: category-change remap (keep / drop / derive)

    func test_partition_keepsValid_dropsInapplicable() {
        let newSpecs = [spec("Brand", .required), spec("Color", .recommended)]
        let current = [
            "Brand": ["Nike"],
            "Color": ["Blue"],
            "Sleeve Length": ["Long Sleeve"], // not in the new spec → dropped
        ]
        let part = SpecificsEditorModel.partitionForCategoryChange(
            current: current, newSpecs: newSpecs
        )
        XCTAssertEqual(part.kept, ["Brand": ["Nike"], "Color": ["Blue"]])
        XCTAssertEqual(part.dropped, ["Sleeve Length": ["Long Sleeve"]])
    }

    func test_partition_ignoresBlankValues() {
        let newSpecs = [spec("Brand", .required)]
        let current = ["Color": [""], "Size": []] // both empty → neither kept nor dropped
        let part = SpecificsEditorModel.partitionForCategoryChange(
            current: current, newSpecs: newSpecs
        )
        XCTAssertTrue(part.kept.isEmpty)
        XCTAssertTrue(part.dropped.isEmpty)
    }

    func test_mergeDerived_fillsOnlyBlanks_neverOverwrites() {
        let current = ["Brand": ["Nike"], "Size": [""]]
        let derived = [
            "Brand": ["Adidas"],        // present → must NOT overwrite
            "Size": ["Medium"],         // blank → filled
            "Sleeve Length": ["Long Sleeve"], // missing → filled
        ]
        let merged = SpecificsEditorModel.mergeDerived(into: current, derived: derived)
        XCTAssertEqual(merged["Brand"], ["Nike"])
        XCTAssertEqual(merged["Size"], ["Medium"])
        XCTAssertEqual(merged["Sleeve Length"], ["Long Sleeve"])
    }
}
