import XCTest
@testable import GradeThread

/// US-2818 — the Swift mirror of `src/lib/listing-templates.ts`. Pure data plus
/// interpolation, so the whole contract is testable without a network or a model.
///
/// US-2964 removed the description-rendering half (the measurement table, the
/// grade line and the seller-credentials block), so the eight cases that covered
/// `measurementsBlock`, `gradeBlock`, `ensureGradeLine`, `splitSellerCredentials`
/// and `ensureSellerCredentials` went with it. Those sections are their own
/// description blocks now and are rendered by the edge service; the block list's
/// own behaviour is covered in `GradeThreadCoreTests/DescriptionBlocksTests`.
final class ListingDescriptionTemplateTests: XCTestCase {

    // MARK: - Group selection

    func test_group_comesFromTheGarmentWord_notTheCategoryEnum() {
        // "clothing" is the item_category enum's value for a t-shirt AND for a
        // suit; on its own it must not decide the template.
        let descriptor = ListingDescriptionTemplate.garmentDescriptor(
            garmentCategory: "blazer",
            garmentType: "outerwear",
            itemCategory: "clothing",
            style: nil,
            title: "Navy wool blazer"
        )
        XCTAssertEqual(descriptor, "blazer")
        XCTAssertEqual(GarmentGroup.from(descriptor), .outerwear)
    }

    /// `garment_type` is derived from the category whenever intake never
    /// captured one, so its six coarse values are a guess. A real garment noun
    /// anywhere else on the item beats them.
    func test_garmentDescriptor_prefersARealGarmentWordOverACoarseVertical() {
        let descriptor = ListingDescriptionTemplate.garmentDescriptor(
            garmentCategory: nil,
            garmentType: "tops",
            itemCategory: "clothing",
            style: nil,
            title: "Levi's 550 Denim Shorts"
        )
        XCTAssertEqual(GarmentGroup.from(descriptor), .bottom)
    }

    /// The coarse value still resolves when it is all there is — "bottoms" beats
    /// `generic`.
    func test_garmentDescriptor_fallsBackToTheCoarseVertical() {
        let descriptor = ListingDescriptionTemplate.garmentDescriptor(
            garmentCategory: nil,
            garmentType: "bottoms",
            itemCategory: "clothing",
            style: nil,
            title: "Untitled item"
        )
        XCTAssertEqual(GarmentGroup.from(descriptor), .bottom)
    }

    func test_garmentDescriptor_lastResortIsTheMostSpecificStringGiven() {
        let descriptor = ListingDescriptionTemplate.garmentDescriptor(
            garmentCategory: nil,
            garmentType: nil,
            itemCategory: "other",
            style: nil,
            title: nil
        )
        XCTAssertEqual(descriptor, "other")
        XCTAssertEqual(GarmentGroup.from(descriptor), .generic)
    }

    // MARK: - Measurement values

    /// A folded-flat measurement publishes BOTH numbers: the worn one a buyer
    /// shops by and the flat one they can reproduce with their own tape.
    func test_measurementLines_doubleCircumferenceKeys_andKeepTheFlatNumber() {
        let lines = ListingDescriptionTemplate.measurementLines(
            ["chest": 21, "length": 28], unit: .inches
        )
        XCTAssertEqual(lines.first, "Chest (pit to pit): 42 in (21 in flat)")
        XCTAssertEqual(lines.last, "Length: 28 in")
    }

    func test_measurementLines_honorTheCentimeterPreference() {
        let lines = ListingDescriptionTemplate.measurementLines(
            ["length": 10], unit: .centimeters
        )
        XCTAssertEqual(lines, ["Length: 25.4 cm"])
    }

    /// Shoe sizes are US numeric and watch dimensions are millimetres; neither
    /// converts with the seller's length preference.
    func test_measurementLines_leaveShoeAndMillimetreKindsAlone() {
        let shoe = ListingDescriptionTemplate.measurementLines(
            ["size_us": 10.5], unit: .centimeters
        )
        XCTAssertEqual(shoe, ["US size: US 10.5"])

        let watch = ListingDescriptionTemplate.measurementLines(
            ["case_diameter": 40], unit: .centimeters
        )
        XCTAssertEqual(watch, ["Case diameter: 40 mm"])
    }

    /// A stored zero is an unset field, not a measurement of nothing.
    func test_measurementLines_dropNonPositiveValues() {
        XCTAssertTrue(
            ListingDescriptionTemplate
                .measurementLines(["chest": 0], unit: .inches).isEmpty
        )
    }

    // MARK: - Build

    func test_build_topTemplate_carriesEveryAttribute() {
        let facts = ListingDescriptionTemplate.Facts(
            brand: "Patagonia",
            title: "Better Sweater",
            size: "M",
            color: "Navy",
            material: "Fleece",
            conditionNotes: "Light pilling at the cuffs.",
            gradeLabel: "Excellent",
            gradeValue: 8.5,
            measurements: ["chest": 21, "length": 27],
            garmentDescriptor: "sweater"
        )
        let out = ListingDescriptionTemplate.build(facts: facts)

        XCTAssertTrue(out.hasPrefix("Patagonia Better Sweater"))
        XCTAssertTrue(out.contains("Size: M"))
        XCTAssertTrue(out.contains("Color: Navy"))
        XCTAssertTrue(out.contains("Material: Fleece"))
        XCTAssertTrue(out.contains("Condition: Light pilling at the cuffs."))
        XCTAssertTrue(out.hasSuffix("Smoke-free home. Ships fast. Questions welcome."))
    }

    /// US-2964: the measurement table and the grade line are their own blocks,
    /// rendered by the edge service on every save. A template that restated them
    /// would publish each fact twice — and only one of the two copies would
    /// follow the seller's next edit.
    func test_build_leavesTheMeasurementsAndTheGradeToTheirOwnBlocks() {
        let facts = ListingDescriptionTemplate.Facts(
            brand: "Patagonia",
            title: "Better Sweater",
            gradeValue: 8.5,
            measurements: ["chest": 21],
            garmentDescriptor: "sweater"
        )
        let out = ListingDescriptionTemplate.build(facts: facts)

        XCTAssertFalse(out.contains("Chest"))
        XCTAssertFalse(out.contains("Measurements"))
        XCTAssertFalse(out.contains("Condition Grade"))
        XCTAssertFalse(out.contains("{{"))
    }

    /// The seller's own note outranks the grade tier, and the tier outranks the
    /// generic line — the web `interpolateDescription` precedence.
    func test_build_conditionPrecedence_notesThenTierThenGeneric() {
        var facts = ListingDescriptionTemplate.Facts(
            gradeLabel: "Excellent", garmentDescriptor: "tee"
        )
        XCTAssertTrue(
            ListingDescriptionTemplate.build(facts: facts)
                .contains("Condition: Excellent")
        )

        facts.conditionNotes = "Small stain on the hem."
        XCTAssertTrue(
            ListingDescriptionTemplate.build(facts: facts)
                .contains("Condition: Small stain on the hem.")
        )

        facts.conditionNotes = ""
        facts.gradeLabel = ""
        XCTAssertTrue(
            ListingDescriptionTemplate.build(facts: facts)
                .contains("Condition: Pre-owned, good condition")
        )
    }

    /// The suit template is the one that says "two pieces" out loud, because a
    /// suit buyer's first question is whether the jacket and trousers match.
    func test_build_suitTemplate_saysSoldAsASet() {
        let facts = ListingDescriptionTemplate.Facts(garmentDescriptor: "two piece suit")
        let out = ListingDescriptionTemplate.build(facts: facts)
        XCTAssertTrue(out.contains("Sold as a two-piece set"))
    }

    /// A watch has no size, colour or material lines at all, so the group choice
    /// has to actually reach the template rather than falling to generic.
    func test_build_watchTemplate_dropsTheGarmentAttributeLines() {
        let facts = ListingDescriptionTemplate.Facts(
            brand: "Seiko",
            title: "SKX007",
            measurements: ["case_diameter": 42],
            garmentDescriptor: "watch"
        )
        let out = ListingDescriptionTemplate.build(facts: facts)
        XCTAssertFalse(out.contains("Size:"))
        XCTAssertFalse(out.contains("Material:"))
        XCTAssertTrue(out.contains("Ships insured. Questions welcome."))
    }

    /// An unset attribute renders as an em dash so the buyer can see the field
    /// was considered — and an ungraded item leaves no blank gap behind.
    func test_build_unsetAttributesBecomeDashes_andNoTripleBlankLines() {
        let facts = ListingDescriptionTemplate.Facts(
            brand: "Nike", title: "Tee", garmentDescriptor: "tee"
        )
        let out = ListingDescriptionTemplate.build(facts: facts)
        XCTAssertTrue(out.contains("Size: \u{2014}"))
        XCTAssertFalse(out.contains("\n\n\n"))
        XCTAssertFalse(out.contains("Condition Grade"))
    }
}
