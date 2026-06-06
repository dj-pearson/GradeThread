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
}
