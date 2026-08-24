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

    func test_reconcileDerived_refreshesAutoAndBlanks_preservesUserAndAI() {
        // Brand was previously auto-derived → a changed item field re-derives it;
        // Color was typed by the user and Style came from AI → both untouched;
        // Size is blank → filled; Sleeve Length is new → filled (and Auto).
        let current = [
            "Brand": ["Nike"],
            "Color": ["Red"],
            "Style": ["Bomber"],
            "Size": [""],
        ]
        let sources: [String: AspectProvenance] = [
            "Brand": .inventoryDerived,
            "Color": .manual,
            "Style": .aiExtracted,
        ]
        let derived = [
            "Brand": ["Adidas"],              // Auto → refreshed from the item
            "Color": ["Blue"],               // would change, but it's user-set → ignored
            "Style": ["Parka"],              // AI-set → ignored
            "Size": ["Medium"],              // blank → filled
            "Sleeve Length": ["Long Sleeve"], // new → filled
        ]
        let result = SpecificsEditorModel.reconcileDerived(
            into: current, sources: sources, derived: derived
        )
        XCTAssertEqual(result.values["Brand"], ["Adidas"])
        XCTAssertEqual(result.values["Color"], ["Red"])
        XCTAssertEqual(result.values["Style"], ["Bomber"])
        XCTAssertEqual(result.values["Size"], ["Medium"])
        XCTAssertEqual(result.values["Sleeve Length"], ["Long Sleeve"])
        // Refreshed/filled aspects are stamped inventory_derived; the user/AI
        // provenance is preserved unchanged.
        XCTAssertEqual(result.sources["Brand"], .inventoryDerived)
        XCTAssertEqual(result.sources["Size"], .inventoryDerived)
        XCTAssertEqual(result.sources["Sleeve Length"], .inventoryDerived)
        XCTAssertEqual(result.sources["Color"], .manual)
        XCTAssertEqual(result.sources["Style"], .aiExtracted)
    }

    // The main-page column outranks its aspect for Brand/Size/Color/Material/
    // Style. reconcileDerived above deliberately protects manual/AI values —
    // correct for every OTHER aspect, but for these five it stranded the
    // seller's edit: they fixed Brand on the item page, the AI-filled Brand
    // aspect won, and they had to retype it in the specifics editor as well.
    func test_applyColumnAuthority_columnBeatsManualAndAI() {
        let reconciled = (
            values: [
                "Brand": ["<UNKNOWN>"],   // AI wrote a placeholder
                "Size": ["S"],            // the seller typed this here earlier
                "Pattern": ["Striped"],   // NOT column-owned
            ],
            sources: [
                "Brand": AspectProvenance.aiExtracted,
                "Size": AspectProvenance.manual,
                "Pattern": AspectProvenance.aiExtracted,
            ]
        )
        let result = SpecificsEditorModel.applyColumnAuthority(
            to: reconciled,
            derived: ["Brand": ["Woolx"], "Size": ["M"], "Pattern": ["Solid"]],
            columnOwned: ["Brand", "Size"],
            columnCleared: []
        )
        // Both column-owned aspects now match the item's columns, whatever
        // provenance they carried before, and are re-stamped as derived.
        XCTAssertEqual(result.values["Brand"], ["Woolx"])
        XCTAssertEqual(result.values["Size"], ["M"])
        XCTAssertEqual(result.sources["Brand"], .inventoryDerived)
        XCTAssertEqual(result.sources["Size"], .inventoryDerived)
        // A non-column aspect keeps the reconcile's answer — this must NOT
        // become a blanket "server always wins" overwrite.
        XCTAssertEqual(result.values["Pattern"], ["Striped"])
        XCTAssertEqual(result.sources["Pattern"], .aiExtracted)
    }

    func test_applyColumnAuthority_blankedColumnDropsTheAspect() {
        let reconciled = (
            values: ["Brand": ["Nike"], "Color": ["Red"]],
            sources: [
                "Brand": AspectProvenance.inventoryDerived,
                "Color": AspectProvenance.manual,
            ]
        )
        // The seller cleared the Brand column on the item page: the specific has
        // to go too, or they'd delete it and watch it come back.
        let result = SpecificsEditorModel.applyColumnAuthority(
            to: reconciled, derived: [:], columnOwned: [], columnCleared: ["Brand"]
        )
        XCTAssertNil(result.values["Brand"])
        XCTAssertNil(result.sources["Brand"])
        XCTAssertEqual(result.values["Color"], ["Red"])
    }

    // An older edge build sends neither list; behaviour must fall back to
    // exactly what reconcileDerived decided, with nothing overwritten.
    func test_applyColumnAuthority_isANoOpWithoutServerLists() {
        let reconciled = (
            values: ["Brand": ["Nike"]],
            sources: ["Brand": AspectProvenance.manual]
        )
        let result = SpecificsEditorModel.applyColumnAuthority(
            to: reconciled,
            derived: ["Brand": ["Adidas"]],
            columnOwned: [],
            columnCleared: []
        )
        XCTAssertEqual(result.values["Brand"], ["Nike"])
        XCTAssertEqual(result.sources["Brand"], .manual)
    }

    // A column-owned name with no derived value must not blank the aspect —
    // "the server sent nothing for it" is not "the seller cleared it" (that is
    // what columnCleared is for).
    func test_applyColumnAuthority_missingDerivedValueLeavesAspectAlone() {
        let reconciled = (
            values: ["Brand": ["Nike"]],
            sources: ["Brand": AspectProvenance.manual]
        )
        let result = SpecificsEditorModel.applyColumnAuthority(
            to: reconciled, derived: [:], columnOwned: ["Brand"], columnCleared: []
        )
        XCTAssertEqual(result.values["Brand"], ["Nike"])
    }

    // MARK: - US-825: provenance persistence

    func test_storedSources_encodesFilledAspectsOnly() {
        let sources: [String: AspectProvenance] = [
            "Brand": .aiExtracted,
            "Color": .inventoryDerived,
            "Size": .manual,
            "Style": .manual,        // cleared value → must be pruned
        ]
        let values = ["Brand": ["Nike"], "Color": ["Blue"], "Size": ["M"], "Style": [""]]
        let stored = SpecificsEditorModel.storedSources(sources, values: values)
        XCTAssertEqual(stored, [
            "Brand": "ai_extracted",
            "Color": "inventory_derived",
            "Size": "manual",
        ])
    }

    func test_provenance_rawValues_matchSharedStrings() {
        // The persisted strings MUST match the web/edge provenance vocabulary.
        XCTAssertEqual(AspectProvenance.aiExtracted.rawValue, "ai_extracted")
        XCTAssertEqual(AspectProvenance.inventoryDerived.rawValue, "inventory_derived")
        XCTAssertEqual(AspectProvenance.manual.rawValue, "manual")
        XCTAssertEqual(AspectProvenance(rawValue: "ai_extracted"), .aiExtracted)
    }

    // MARK: - US-1513: dirty tracking (drives the back-swipe guard)

    @MainActor
    func test_isDirty_falseOnFreshModel_trueAfterEdit_clearsWhenReverted() {
        let model = SpecificsEditorModel(itemId: "item-1")
        XCTAssertFalse(model.isDirty)

        model.setSingle("Levi's", for: "Brand")
        XCTAssertTrue(model.isDirty)

        // Clearing the only edit returns to the (empty) baseline.
        model.setSingle("", for: "Brand")
        XCTAssertFalse(model.isDirty)
    }

    @MainActor
    func test_isDirty_ignoresBlankValues_countsMultiToggle() {
        let model = SpecificsEditorModel(itemId: "item-1")
        // A blank write is normalized away — not dirty.
        model.setSingle("   ", for: "Brand")
        XCTAssertFalse(model.isDirty)

        model.toggleMulti("Waterproof", for: "Features")
        XCTAssertTrue(model.isDirty)
        model.toggleMulti("Waterproof", for: "Features")
        XCTAssertFalse(model.isDirty)
    }

    // MARK: - Inline item-page grouping

    // The item page renders the specifics INLINE, under the item's own
    // Brand/Size/Color/Material/Style inputs. Those aspects are projections of
    // the same columns, so showing them again is the "why am I typing this in
    // two places" confusion the seller reported. The standalone list keeps them
    // (there, they are the only place to type a Brand).
    @MainActor
    func test_specsUsage_hidesColumnBackedAspectsInline() {
        let model = SpecificsEditorModel(itemId: "item-1")
        model.specs = [
            AspectSpec(name: "Brand", usage: .required, selectionOnly: false,
                       multiSelect: false, allowedValues: []),
            AspectSpec(name: "Department", usage: .required, selectionOnly: true,
                       multiSelect: false, allowedValues: ["Men", "Women"]),
            AspectSpec(name: "Color", usage: .recommended, selectionOnly: false,
                       multiSelect: false, allowedValues: ["Black"]),
            AspectSpec(name: "Pattern", usage: .recommended, selectionOnly: false,
                       multiSelect: false, allowedValues: []),
            AspectSpec(name: "Occasion", usage: .optional, selectionOnly: false,
                       multiSelect: false, allowedValues: []),
        ]
        model.applyColumnBackedNamesForTesting(["Brand", "Color"])

        // Inline: the column-backed rows are gone, everything else stays.
        XCTAssertEqual(model.specs(usage: .required, hidingColumnBacked: true).map(\.name),
                       ["Department"])
        XCTAssertEqual(model.specs(usage: .recommended, hidingColumnBacked: true).map(\.name),
                       ["Pattern"])
        XCTAssertEqual(model.specs(usage: .optional, hidingColumnBacked: true).map(\.name),
                       ["Occasion"])

        // Not hiding: nothing is dropped.
        XCTAssertEqual(model.specs(usage: .required, hidingColumnBacked: false).map(\.name),
                       ["Brand", "Department"])
        XCTAssertEqual(model.specs(usage: .recommended, hidingColumnBacked: false).map(\.name),
                       ["Color", "Pattern"])
    }

    // eBay's casing is not ours; a case-sensitive compare would leak a duplicate
    // Brand row onto the page.
    @MainActor
    func test_isColumnBacked_isCaseAndWhitespaceInsensitive() {
        let model = SpecificsEditorModel(itemId: "item-1")
        model.applyColumnBackedNamesForTesting(["Brand", "US Shoe Size"])
        XCTAssertTrue(model.isColumnBacked("brand"))
        XCTAssertTrue(model.isColumnBacked("  BRAND "))
        XCTAssertTrue(model.isColumnBacked("US Shoe Size"))
        XCTAssertFalse(model.isColumnBacked("Brand Name"))
        XCTAssertFalse(model.isColumnBacked("Department"))
    }

    // MARK: - US-2839: what the item's OWN inputs render from

    // The hide-list says which rows to drop. It cannot say what the item's Style
    // input should offer, because it never states which aspect the style column
    // drives -- so the pairing is a separate answer, and this is the lookup the
    // item page uses for it.
    @MainActor
    func test_columnSpec_findsTheAspectTheColumnDrives() {
        let model = SpecificsEditorModel(itemId: "item-1")
        model.specs = [
            AspectSpec(name: "Style", usage: .recommended, selectionOnly: true,
                       multiSelect: false,
                       allowedValues: ["Basic", "Cropped", "Jersey", "Pullover", "Ringer"]),
            AspectSpec(name: "Type", usage: .optional, selectionOnly: false,
                       multiSelect: false, allowedValues: []),
            AspectSpec(name: "US Shoe Size", usage: .required, selectionOnly: true,
                       multiSelect: false, allowedValues: ["9", "10"]),
        ]
        model.applyColumnAspectNamesForTesting(["style": "Style", "size": "US Shoe Size"])

        let style = model.columnSpec(for: "style")
        XCTAssertEqual(style?.name, "Style")
        XCTAssertEqual(style?.allowedValues,
                       ["Basic", "Cropped", "Jersey", "Pullover", "Ringer"])
        // The size column owns the shoe-specific name here, NOT the generic one
        // -- getting this backwards puts shoe sizes behind a shirt's Size field.
        XCTAssertEqual(model.columnSpec(for: "size")?.name, "US Shoe Size")
        // A column this category has no aspect for stays a plain text field.
        XCTAssertNil(model.columnSpec(for: "material"))
    }

    // eBay's casing is not ours, and the column key comes from our own code.
    @MainActor
    func test_columnSpec_matchesCaseAndWhitespaceInsensitively() {
        let model = SpecificsEditorModel(itemId: "item-1")
        model.specs = [
            AspectSpec(name: "Colour", usage: .recommended, selectionOnly: false,
                       multiSelect: false, allowedValues: ["Black"]),
        ]
        model.applyColumnAspectNamesForTesting(["COLOR": "  colour  "])
        XCTAssertEqual(model.columnSpec(for: " Color ")?.name, "Colour")
        XCTAssertNil(model.columnSpec(for: ""))
    }

    // An older edge build sends no pairing. Falling back to the column's own
    // name upgrades the obvious cases (style -> "Style") instead of leaving
    // every field plain until the edge catches up -- and when the category has
    // no aspect by that name, it is plain text, which is the old behaviour.
    @MainActor
    func test_columnSpec_fallsBackToTheColumnName() {
        let model = SpecificsEditorModel(itemId: "item-1")
        model.specs = [
            AspectSpec(name: "Style", usage: .recommended, selectionOnly: true,
                       multiSelect: false, allowedValues: ["Bomber", "Parka"]),
        ]
        XCTAssertEqual(model.columnSpec(for: "style")?.name, "Style")
        XCTAssertNil(model.columnSpec(for: "size"))
    }

    // An older edge build sends no list — nothing is hidden, which is exactly
    // the pre-change behaviour rather than an empty specifics section.
    @MainActor
    func test_noColumnBackedNames_hidesNothing() {
        let model = SpecificsEditorModel(itemId: "item-1")
        model.specs = [
            AspectSpec(name: "Brand", usage: .required, selectionOnly: false,
                       multiSelect: false, allowedValues: []),
        ]
        XCTAssertEqual(model.specs(usage: .required, hidingColumnBacked: true).map(\.name),
                       ["Brand"])
    }
}
