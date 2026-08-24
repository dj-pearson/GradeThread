import XCTest
@testable import GradeThread

/// US-2839: the item's own Brand/Size/Color/Material/Style inputs render from
/// the chosen eBay category's spec. These are the pure parts of that decision —
/// which options the picker shows, which one is selected, and how an off-list
/// value is labelled.
final class ColumnAspectFieldTests: XCTestCase {

    private func closed(_ values: [String]) -> AspectSpec {
        AspectSpec(name: "Style", usage: .recommended, selectionOnly: true,
                   multiSelect: false, allowedValues: values)
    }

    private let jacketStyles = ["Basic", "Cropped", "Jersey", "Pullover", "Ringer"]

    func test_options_areEbaysListWhenTheValueIsOnIt() {
        let spec = closed(jacketStyles)
        XCTAssertEqual(ColumnAspectField.options(for: spec, current: ""), jacketStyles)
        XCTAssertEqual(ColumnAspectField.options(for: spec, current: "Cropped"), jacketStyles)
        // Case and padding are the seller's, not eBay's — neither makes a value
        // off-list, and treating them as such would double the option.
        XCTAssertEqual(ColumnAspectField.options(for: spec, current: "  cropped "), jacketStyles)
    }

    func test_options_carryAnOffListValueSoThePickerIsNeverBlank() {
        let spec = closed(jacketStyles)
        // A picker whose bound value matches no tag shows NO selection: the row
        // would read as empty over a real value, and the next save would write
        // that blank back to the column.
        XCTAssertEqual(
            ColumnAspectField.options(for: spec, current: "Bomber"),
            jacketStyles + ["Bomber"]
        )
    }

    func test_canonical_readsEbaysSpellingOfWhatTheColumnHolds() {
        let spec = closed(jacketStyles)
        XCTAssertEqual(ColumnAspectField.canonical("cropped", in: spec), "Cropped")
        XCTAssertEqual(ColumnAspectField.canonical("  PULLOVER  ", in: spec), "Pullover")
        // No match — hand it back untouched, and options() will carry it.
        XCTAssertEqual(ColumnAspectField.canonical("Bomber", in: spec), "Bomber")
        // Empty stays empty: that is the picker's own "—" row.
        XCTAssertEqual(ColumnAspectField.canonical("   ", in: spec), "")
    }

    // The selected option and the option list have to agree, or the picker
    // renders blank. This is the pairing the two helpers must never break.
    func test_canonicalValueIsAlwaysOneOfTheOptions() {
        let spec = closed(jacketStyles)
        for current in ["", "Cropped", "cropped", "  ringer", "Bomber", "  "] {
            let options = ColumnAspectField.options(for: spec, current: current)
            let selected = ColumnAspectField.canonical(current, in: spec)
            XCTAssertTrue(
                selected.isEmpty || options.contains(selected),
                "\(current) selected \(selected), which is not an option"
            )
        }
    }

    func test_optionLabel_marksOnlyTheOffListValue() {
        let spec = closed(jacketStyles)
        XCTAssertEqual(ColumnAspectField.optionLabel("Cropped", in: spec), "Cropped")
        XCTAssertEqual(ColumnAspectField.optionLabel("cropped", in: spec), "cropped")
        XCTAssertEqual(
            ColumnAspectField.optionLabel("Bomber", in: spec),
            "Bomber (not an eBay value)"
        )
    }
}
