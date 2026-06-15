import XCTest
@testable import GradeThread

/// Pure duplicate-SKU merge math (no networking) — the iOS mirror of the web
/// MergeSkuDialog's conflict computation.
@MainActor
final class ItemMergePlanTests: XCTestCase {

    private struct FakeError: LocalizedError {
        let msg: String
        var errorDescription: String? { msg }
    }

    private func draft(
        title: String = "Linen blazer",
        brand: String = "Patagonia",
        size: String = "M",
        targetPrice: String = "35",
        category: FlipdeskCategory? = .clothing,
        status: String = "cataloged",
        notes: String = ""
    ) -> ItemDraft {
        ItemDraft(
            title: title, brand: brand, sku: "S-12", size: size,
            color: "", material: "", conditionNotes: notes,
            status: status, category: category,
            targetPriceText: targetPrice, acquiredPriceText: "",
            locationBin: "", consignorId: nil, consignmentSplitText: ""
        )
    }

    private func existing(
        title: String? = nil,
        brand: String? = nil,
        size: String? = nil,
        color: String? = nil,
        material: String? = nil,
        condition_notes: String? = nil,
        status: String? = nil,
        item_category: String? = nil,
        target_price: Double? = nil,
        acquired_price: Double? = nil,
        location_bin: String? = nil
    ) -> ExistingSkuItem {
        ExistingSkuItem(
            id: "dup-1", title: title, brand: brand, size: size, color: color,
            material: material, condition_notes: condition_notes, status: status,
            item_category: item_category, target_price: target_price,
            acquired_price: acquired_price, location_bin: location_bin
        )
    }

    // MARK: - isDuplicateSkuError

    func test_isDuplicateSkuError_matchesConstraintMessage() {
        let err = FakeError(
            msg: "duplicate key value violates unique constraint \"idx_inventory_items_user_sku\""
        )
        XCTAssertTrue(ItemMergePlan.isDuplicateSkuError(err))
    }

    func test_isDuplicateSkuError_matchesGenericDuplicateWithSku() {
        XCTAssertTrue(ItemMergePlan.isDuplicateSkuError(FakeError(msg: "23505: duplicate sku")))
    }

    func test_isDuplicateSkuError_ignoresUnrelatedErrors() {
        XCTAssertFalse(ItemMergePlan.isDuplicateSkuError(FakeError(msg: "network timeout")))
        // A different unique violation (not the SKU index) must NOT trigger a merge.
        XCTAssertFalse(ItemMergePlan.isDuplicateSkuError(
            FakeError(msg: "23505 duplicate key ... constraint \"some_other_idx\"")
        ))
    }

    // MARK: - conflicts

    func test_conflicts_skipsEqualAndEmptyFields() {
        // Existing matches on brand, is blank on size — neither is a conflict.
        let conflicts = ItemMergePlan.conflicts(
            current: draft(brand: "Patagonia", size: "M"),
            existing: existing(brand: "Patagonia", size: nil)
        )
        XCTAssertTrue(conflicts.isEmpty)
    }

    func test_conflicts_realConflictWhenBothFilledAndDiffer() throws {
        let conflicts = ItemMergePlan.conflicts(
            current: draft(brand: "Patagonia"),
            existing: existing(brand: "The North Face")
        )
        XCTAssertEqual(conflicts.count, 1)
        let brand = try XCTUnwrap(conflicts.first { $0.field == .brand })
        XCTAssertEqual(brand.currentDisplay, "Patagonia")
        XCTAssertEqual(brand.existingDisplay, "The North Face")
        XCTAssertTrue(brand.bothFilled)
    }

    func test_conflicts_gapFillWhenOnlyExistingHasValue() {
        let conflicts = ItemMergePlan.conflicts(
            current: draft(notes: ""),
            existing: existing(condition_notes: "Small stain on cuff")
        )
        let notes = conflicts.first { $0.field == .conditionNotes }
        XCTAssertEqual(notes?.bothFilled, false)
        XCTAssertEqual(notes?.currentDisplay, "(empty)")
        XCTAssertEqual(notes?.existingDisplay, "Small stain on cuff")
    }

    func test_conflicts_priceEqualityIgnoresTrailingZeros() {
        // 35 vs 35.00 are the same price — not a conflict.
        let conflicts = ItemMergePlan.conflicts(
            current: draft(targetPrice: "35"),
            existing: existing(target_price: 35.00)
        )
        XCTAssertFalse(conflicts.contains { $0.field == .targetPrice })
    }

    func test_conflicts_categoryUsesHumanLabel() {
        let conflicts = ItemMergePlan.conflicts(
            current: draft(category: .clothing),
            existing: existing(item_category: "shoes")
        )
        let cat = conflicts.first { $0.field == .category }
        XCTAssertEqual(cat?.currentDisplay, "Clothing")
        XCTAssertEqual(cat?.existingDisplay, "Shoes")
    }

    // MARK: - defaults & apply

    func test_defaultKeepExisting_onlyGapFills() {
        let conflicts = ItemMergePlan.conflicts(
            current: draft(brand: "Patagonia", notes: ""),
            existing: existing(brand: "The North Face", condition_notes: "Stain")
        )
        let keep = ItemMergePlan.defaultKeepExisting(conflicts)
        XCTAssertTrue(keep.contains(.conditionNotes))  // gap-fill → take existing
        XCTAssertFalse(keep.contains(.brand))          // real conflict → keep this item
    }

    func test_apply_overwritesOnlyChosenFields() {
        var d = draft(brand: "Patagonia", targetPrice: "35")
        let ex = existing(brand: "The North Face", target_price: 50.0, location_bin: "Bin 7")
        ItemMergePlan.apply([.brand, .locationBin], from: ex, to: &d)

        XCTAssertEqual(d.brand, "The North Face")  // chosen → taken from existing
        XCTAssertEqual(d.locationBin, "Bin 7")     // chosen → taken from existing
        XCTAssertEqual(d.targetPriceText, "35")    // not chosen → unchanged
    }

    func test_apply_categoryMapsRawValueBackToEnum() {
        var d = draft(category: .clothing)
        ItemMergePlan.apply([.category], from: existing(item_category: "watches"), to: &d)
        XCTAssertEqual(d.category, .watches)
    }
}
