import Foundation

/// Pre-existing inventory row that already owns a contested SKU, fetched when a
/// save trips the partial unique index `idx_inventory_items_user_sku`
/// (user_id, sku). Decodes only the user-editable subset of `inventory_items`
/// the merge UI compares; non-UI columns (grade linkage, eBay taxonomy,
/// consignment, …) are coalesced server-side by the `merge_inventory_items`
/// RPC, so they're deliberately absent here. Mirrors the web merge dialog
/// (`src/components/flipdesk/merge-sku-dialog.tsx`).
struct ExistingSkuItem: Decodable, Identifiable, Equatable {
    let id: String
    let title: String?
    let brand: String?
    let size: String?
    let color: String?
    let material: String?
    let condition_notes: String?
    let status: String?
    let item_category: String?
    let target_price: Double?
    let acquired_price: Double?
    let location_bin: String?
    // Extra columns used only by the intake "combine into existing" flow for
    // lossless gap-filling. The edit-canvas fetch omits them (→ nil), which is
    // harmless because the canvas merge never reads them. (Property names match
    // the snake_case columns, so synthesized Decodable keys are correct and a
    // partial select simply leaves the absent optionals nil.)
    let style: String?
    let container: String?
    let sourced_by: String?
    let description: String?
    let acquired_date: String?
    let source_id: String?

    init(
        id: String, title: String?, brand: String?, size: String?, color: String?,
        material: String?, condition_notes: String?, status: String?,
        item_category: String?, target_price: Double?, acquired_price: Double?,
        location_bin: String?, style: String? = nil, container: String? = nil,
        sourced_by: String? = nil, description: String? = nil,
        acquired_date: String? = nil, source_id: String? = nil
    ) {
        self.id = id
        self.title = title
        self.brand = brand
        self.size = size
        self.color = color
        self.material = material
        self.condition_notes = condition_notes
        self.status = status
        self.item_category = item_category
        self.target_price = target_price
        self.acquired_price = acquired_price
        self.location_bin = location_bin
        self.style = style
        self.container = container
        self.sourced_by = sourced_by
        self.description = description
        self.acquired_date = acquired_date
        self.source_id = source_id
    }
}

/// The user-editable fields the canvas can resolve during a duplicate-SKU
/// merge. Restricted to what `ItemDraft` exposes (the web dialog has a few
/// more, e.g. description/comps/measurements, that the iOS canvas doesn't edit
/// yet); everything else is coalesced by the RPC.
enum ItemMergeField: String, CaseIterable, Identifiable {
    case title
    case brand
    case size
    case color
    case material
    case category
    case status
    case targetPrice
    case acquiredPrice
    case locationBin
    case conditionNotes

    var id: String { rawValue }

    var label: String {
        switch self {
        case .title:         return "Title"
        case .brand:         return "Brand"
        case .size:          return "Size"
        case .color:         return "Color"
        case .material:      return "Material"
        case .category:      return "Category"
        case .status:        return "Status"
        case .targetPrice:   return "Target price"
        case .acquiredPrice: return "Purchase price"
        case .locationBin:   return "Location / bin"
        case .conditionNotes: return "Internal notes"
        }
    }

    /// A field value reduced to a comparison key (`normalized`) and a
    /// human-readable `display`. Conflicts are detected on `normalized`.
    struct Value {
        let normalized: String
        let display: String
    }

    func current(_ draft: ItemDraft, _ formatter: CurrencyFormatter) -> Value {
        switch self {
        case .title:          return Self.text(draft.title)
        case .brand:          return Self.text(draft.brand)
        case .size:           return Self.text(draft.size)
        case .color:          return Self.text(draft.color)
        case .material:       return Self.text(draft.material)
        case .conditionNotes: return Self.text(draft.conditionNotes)
        case .locationBin:    return Self.text(draft.locationBin)
        case .category:       return Self.category(draft.category?.rawValue)
        case .status:         return Self.status(draft.status)
        case .targetPrice:    return Self.price(formatter.parse(draft.targetPriceText), formatter)
        case .acquiredPrice:  return Self.price(formatter.parse(draft.acquiredPriceText), formatter)
        }
    }

    func existing(_ item: ExistingSkuItem, _ formatter: CurrencyFormatter) -> Value {
        switch self {
        case .title:          return Self.text(item.title)
        case .brand:          return Self.text(item.brand)
        case .size:           return Self.text(item.size)
        case .color:          return Self.text(item.color)
        case .material:       return Self.text(item.material)
        case .conditionNotes: return Self.text(item.condition_notes)
        case .locationBin:    return Self.text(item.location_bin)
        case .category:       return Self.category(item.item_category)
        case .status:         return Self.status(item.status)
        case .targetPrice:    return Self.price(item.target_price, formatter)
        case .acquiredPrice:  return Self.price(item.acquired_price, formatter)
        }
    }

    /// Copies the existing record's value for this field onto the draft.
    func apply(_ item: ExistingSkuItem, to draft: inout ItemDraft, _ formatter: CurrencyFormatter) {
        switch self {
        case .title:          draft.title = (item.title ?? "").trimmed
        case .brand:          draft.brand = (item.brand ?? "").trimmed
        case .size:           draft.size = (item.size ?? "").trimmed
        case .color:          draft.color = (item.color ?? "").trimmed
        case .material:       draft.material = (item.material ?? "").trimmed
        case .conditionNotes: draft.conditionNotes = (item.condition_notes ?? "").trimmed
        case .locationBin:    draft.locationBin = (item.location_bin ?? "").trimmed
        case .category:       draft.category = item.item_category.flatMap(FlipdeskCategory.init(rawValue:))
        case .status:         if let s = item.status, !s.isEmpty { draft.status = s }
        case .targetPrice:    draft.targetPriceText = item.target_price.map(formatter.formatRaw) ?? ""
        case .acquiredPrice:  draft.acquiredPriceText = item.acquired_price.map(formatter.formatRaw) ?? ""
        }
    }

    // MARK: - Value builders

    private static func text(_ raw: String?) -> Value {
        let t = (raw ?? "").trimmed
        return Value(normalized: t, display: t)
    }

    private static func category(_ raw: String?) -> Value {
        guard let raw, !raw.isEmpty else { return Value(normalized: "", display: "") }
        let label = FlipdeskCategory(rawValue: raw)?.label ?? raw
        return Value(normalized: raw, display: label)
    }

    private static func status(_ raw: String?) -> Value {
        guard let raw, !raw.isEmpty else { return Value(normalized: "", display: "") }
        let pretty = raw.replacingOccurrences(of: "_", with: " ").capitalized
        return Value(normalized: raw, display: pretty)
    }

    private static func price(_ value: Double?, _ formatter: CurrencyFormatter) -> Value {
        guard let value else { return Value(normalized: "", display: "") }
        // Normalize to cents so 12 and 12.00 compare equal.
        let cents = Int((value * 100).rounded())
        // US-1155: locale/override currency display rather than a hardcoded "$".
        return Value(normalized: String(cents), display: formatter.formatDisplay(value))
    }
}

/// One field where the existing record has a value worth offering. Surfaced as
/// a row in the merge sheet.
struct ItemMergeConflict: Identifiable, Equatable {
    let field: ItemMergeField
    let label: String
    /// What the item being edited currently has (`(empty)` when blank).
    let currentDisplay: String
    /// What the pre-existing record has.
    let existingDisplay: String
    /// True when BOTH records have a value (a real conflict to weigh in on);
    /// false when only the existing record has one (a gap-fill).
    let bothFilled: Bool

    var id: String { field.rawValue }
}

/// Pure merge math — no networking, so it's unit-testable in isolation
/// (mirrors how the web dialog computes its conflict rows).
enum ItemMergePlan {
    /// True when a Postgres error is the duplicate-SKU unique-index violation
    /// we can recover from with a merge (vs. any other save failure).
    static func isDuplicateSkuError(_ error: Error) -> Bool {
        let msg = error.localizedDescription.lowercased()
        if msg.contains("idx_inventory_items_user_sku") { return true }
        // Fall back to the generic shape in case the constraint name isn't
        // surfaced (mirrors InventoryImportService's detection).
        let dup = msg.contains("23505") || msg.contains("duplicate key")
        return dup && msg.contains("sku")
    }

    /// Fields where the existing record has a value that differs from this
    /// item's. A field both records leave equal (or that the existing record
    /// leaves blank) is skipped — the surviving item's value stands regardless.
    static func conflicts(
        current draft: ItemDraft,
        existing item: ExistingSkuItem,
        formatter: CurrencyFormatter = CurrencyFormatter()
    ) -> [ItemMergeConflict] {
        var out: [ItemMergeConflict] = []
        for field in ItemMergeField.allCases {
            let cur = field.current(draft, formatter)
            let ex = field.existing(item, formatter)
            if ex.normalized.isEmpty { continue }            // nothing to take
            if ex.normalized == cur.normalized { continue }  // already equal
            out.append(ItemMergeConflict(
                field: field,
                label: field.label,
                currentDisplay: cur.display.isEmpty ? "(empty)" : cur.display,
                existingDisplay: ex.display,
                bothFilled: !cur.normalized.isEmpty
            ))
        }
        return out
    }

    /// Default choice per field: real conflicts keep THIS item's value (it's
    /// the most recent edit); fields this item left blank are filled from the
    /// existing record. Matches the web dialog's defaulting.
    static func defaultKeepExisting(_ conflicts: [ItemMergeConflict]) -> Set<ItemMergeField> {
        Set(conflicts.filter { !$0.bothFilled }.map(\.field))
    }

    /// Overwrites the chosen fields on the draft with the existing record's
    /// values; everything else keeps the surviving item's value.
    static func apply(
        _ chosen: Set<ItemMergeField>,
        from item: ExistingSkuItem,
        to draft: inout ItemDraft,
        formatter: CurrencyFormatter = CurrencyFormatter()
    ) {
        for field in chosen { field.apply(item, to: &draft, formatter) }
    }
}
