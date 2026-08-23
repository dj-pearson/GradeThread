import XCTest
@testable import GradeThread

/// US-2818 — the Swift mirror of `src/lib/listing-templates.ts`. Pure data plus
/// interpolation, so the whole contract is testable without a network or a model.
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

    // MARK: - Measurements

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

    func test_measurementsBlock_saysSoWhenThereAreNone() {
        XCTAssertEqual(
            ListingDescriptionTemplate.measurementsBlock([:], unit: .inches),
            "(measurements available on request)"
        )
    }

    /// A stored zero is an unset field, not a measurement of nothing.
    func test_measurementLines_dropNonPositiveValues() {
        XCTAssertTrue(
            ListingDescriptionTemplate
                .measurementLines(["chest": 0], unit: .inches).isEmpty
        )
    }

    // MARK: - Grade line

    func test_gradeBlock_carriesOneDecimal_andNoURL() {
        let block = ListingDescriptionTemplate.gradeBlock(gradeValue: 8.5)
        XCTAssertEqual(block, "Graded by GradeThread - Condition Grade 8.5")
        // eBay bans off-eBay links in listings.
        XCTAssertFalse(block.contains("http"))
    }

    func test_gradeBlock_isEmptyForAnUngradedItem() {
        XCTAssertEqual(ListingDescriptionTemplate.gradeBlock(gradeValue: nil), "")
    }

    /// Idempotent: an AI regenerate drops the line, so it is re-appended — but
    /// a description that still carries one is left alone rather than gaining a
    /// second.
    func test_ensureGradeLine_appendsOnceAndOnlyWhenMissing() {
        let appended = ListingDescriptionTemplate.ensureGradeLine(
            "Great tee.", gradeValue: 9
        )
        XCTAssertEqual(appended, "Great tee.\n\nGraded by GradeThread - Condition Grade 9.0")

        let twice = ListingDescriptionTemplate.ensureGradeLine(appended, gradeValue: 9)
        XCTAssertEqual(twice, appended)
    }

    func test_ensureGradeLine_isANoOpForAnUngradedItem() {
        XCTAssertEqual(
            ListingDescriptionTemplate.ensureGradeLine("Great tee.", gradeValue: nil),
            "Great tee."
        )
    }

    // MARK: - Seller credentials block

    func test_splitSellerCredentials_separatesBodyFromTheAppendedBlock() {
        let marker = ListingDescriptionTemplate.sellerCredentialsMarker
        let full = "Body copy.\n\n" + marker + "<div>Verified</div>"
        let split = ListingDescriptionTemplate.splitSellerCredentials(full)
        XCTAssertEqual(split.body, "Body copy.")
        XCTAssertEqual(split.credentials, marker + "<div>Verified</div>")
    }

    /// A rewrite writes fresh copy that drops the block — and sometimes echoes a
    /// mangled marker back. The ORIGINAL block is what gets re-appended.
    func test_ensureSellerCredentials_reAppendsTheOriginalBlock() {
        let marker = ListingDescriptionTemplate.sellerCredentialsMarker
        let original = "Old copy.\n" + marker + "<div>Verified</div>"
        let rewritten = "New copy."

        let out = ListingDescriptionTemplate.ensureSellerCredentials(
            rewritten, original: original
        )
        XCTAssertEqual(out, "New copy.\n" + marker + "<div>Verified</div>")
    }

    func test_ensureSellerCredentials_isANoOpWhenTheOriginalHadNone() {
        XCTAssertEqual(
            ListingDescriptionTemplate.ensureSellerCredentials(
                "New copy.", original: "Old copy."
            ),
            "New copy."
        )
    }

    // MARK: - Build

    func test_build_topTemplate_carriesEveryAttributeAndTheGradeLine() {
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
        let out = ListingDescriptionTemplate.build(facts: facts, unit: .inches)

        XCTAssertTrue(out.hasPrefix("Patagonia Better Sweater"))
        XCTAssertTrue(out.contains("Size: M"))
        XCTAssertTrue(out.contains("Color: Navy"))
        XCTAssertTrue(out.contains("Material: Fleece"))
        XCTAssertTrue(out.contains("Condition: Light pilling at the cuffs."))
        XCTAssertTrue(out.contains("Measurements (garment laid flat):"))
        XCTAssertTrue(out.contains("Chest (pit to pit): 42 in (21 in flat)"))
        XCTAssertTrue(out.contains("Graded by GradeThread - Condition Grade 8.5"))
        XCTAssertTrue(out.hasSuffix("Smoke-free home. Ships fast. Questions welcome."))
    }

    /// The seller's own note outranks the grade tier, and the tier outranks the
    /// generic line — the web `interpolateDescription` precedence.
    func test_build_conditionPrecedence_notesThenTierThenGeneric() {
        var facts = ListingDescriptionTemplate.Facts(
            gradeLabel: "Excellent", garmentDescriptor: "tee"
        )
        XCTAssertTrue(
            ListingDescriptionTemplate.build(facts: facts, unit: .inches)
                .contains("Condition: Excellent")
        )

        facts.conditionNotes = "Small stain on the hem."
        XCTAssertTrue(
            ListingDescriptionTemplate.build(facts: facts, unit: .inches)
                .contains("Condition: Small stain on the hem.")
        )

        facts.conditionNotes = ""
        facts.gradeLabel = ""
        XCTAssertTrue(
            ListingDescriptionTemplate.build(facts: facts, unit: .inches)
                .contains("Condition: Pre-owned, good condition")
        )
    }

    /// The suit template is the one that says "two pieces" out loud, because a
    /// suit buyer's first question is whether the jacket and trousers match.
    func test_build_suitTemplate_saysSoldAsASet() {
        let facts = ListingDescriptionTemplate.Facts(garmentDescriptor: "two piece suit")
        let out = ListingDescriptionTemplate.build(facts: facts, unit: .inches)
        XCTAssertTrue(out.contains("Sold as a two-piece set"))
        XCTAssertTrue(out.contains("Measurements (each piece laid flat):"))
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
        let out = ListingDescriptionTemplate.build(facts: facts, unit: .inches)
        XCTAssertFalse(out.contains("Size:"))
        XCTAssertFalse(out.contains("Material:"))
        XCTAssertTrue(out.contains("Specs:"))
        XCTAssertTrue(out.contains("Ships insured. Questions welcome."))
    }

    /// An unset attribute renders as an em dash so the buyer can see the field
    /// was considered — and an ungraded item leaves no blank gap behind.
    func test_build_unsetAttributesBecomeDashes_andNoTripleBlankLines() {
        let facts = ListingDescriptionTemplate.Facts(
            brand: "Nike", title: "Tee", garmentDescriptor: "tee"
        )
        let out = ListingDescriptionTemplate.build(facts: facts, unit: .inches)
        XCTAssertTrue(out.contains("Size: \u{2014}"))
        XCTAssertFalse(out.contains("\n\n\n"))
        XCTAssertFalse(out.contains("Condition Grade"))
    }
}
