import Foundation

/// Editable snapshot of an `inventory_items` row used by ItemCanvasView.
/// Value type so the canvas can compare a draft against the original
/// snapshot to compute `isDirty` without holding two SwiftData instances.
public struct ItemDraft: Equatable {
    public var title: String
    public var brand: String
    public var sku: String
    public var size: String
    public var color: String
    public var material: String
    public var conditionNotes: String
    public var status: String
    public var category: FlipdeskCategory?
    /// Clothing classification raw values ("" = unset). Required to grade a
    /// clothing item; only edited when `category == .clothing`.
    public var garmentType: String
    public var garmentCategory: String
    /// Buyer-facing listing copy, style/variant note, and who sourced the item
    /// (web parity). Free-form; empty saves as NULL.
    public var itemDescription: String
    public var style: String
    public var sourcedBy: String
    /// Acquisition date (nil = unset), storage/acquisition container label, and
    /// the hand-curated comparable sales (web parity).
    public var acquiredDate: Date?
    public var container: String
    public var compSet: [ItemComp]
    public var targetPriceText: String
    public var acquiredPriceText: String
    /// US-676: storage location / bin label and consignment link.
    public var locationBin: String
    public var consignorId: String?
    /// Per-item consignor split override as a 0–100 string ("" = use the
    /// consignor's default).
    public var consignmentSplitText: String
    /// Editable flat garment measurements keyed by canonical key (see
    /// ``MeasurementCatalog``). LENGTH values are inches. Edited in the canvas
    /// Measurements section; encoded to the `measurements` jsonb column on save.
    public var measurements: [String: Double]

    public init(
        title: String = "",
        brand: String = "",
        sku: String = "",
        size: String = "",
        color: String = "",
        material: String = "",
        conditionNotes: String = "",
        status: String = "cataloged",
        category: FlipdeskCategory? = nil,
        garmentType: String = "",
        garmentCategory: String = "",
        itemDescription: String = "",
        style: String = "",
        sourcedBy: String = "",
        acquiredDate: Date? = nil,
        container: String = "",
        compSet: [ItemComp] = [],
        targetPriceText: String = "",
        acquiredPriceText: String = "",
        locationBin: String = "",
        consignorId: String? = nil,
        consignmentSplitText: String = "",
        measurements: [String: Double] = [:]
    ) {
        self.title = title
        self.brand = brand
        self.sku = sku
        self.size = size
        self.color = color
        self.material = material
        self.conditionNotes = conditionNotes
        self.status = status
        self.category = category
        self.garmentType = garmentType
        self.garmentCategory = garmentCategory
        self.itemDescription = itemDescription
        self.style = style
        self.sourcedBy = sourcedBy
        self.acquiredDate = acquiredDate
        self.container = container
        self.compSet = compSet
        self.targetPriceText = targetPriceText
        self.acquiredPriceText = acquiredPriceText
        self.locationBin = locationBin
        self.consignorId = consignorId
        self.consignmentSplitText = consignmentSplitText
        self.measurements = measurements
    }

    /// Populate from a LocalInventoryItem. The numeric fields go through
    /// a string box so the user can type freely; CurrencyFormatter
    /// parses back to Double on save.
    init(from item: LocalInventoryItem, currencyFormatter: CurrencyFormatter = CurrencyFormatter()) {
        self.title = item.title
        self.brand = item.brand ?? ""
        self.sku = item.sku ?? ""
        self.size = item.size ?? ""
        self.color = item.color ?? ""
        self.material = item.material ?? ""
        self.conditionNotes = item.conditionNotes ?? ""
        self.status = item.status
        // Seed the category from the synced `item_category` so the picker shows
        // the real value (and a save round-trips it instead of nulling it out),
        // and so the clothing-only garment pickers gate correctly.
        self.category = item.itemCategory.flatMap(FlipdeskCategory.init(rawValue:))
        self.garmentType = item.garmentType ?? ""
        self.garmentCategory = item.garmentCategory ?? ""
        self.itemDescription = item.itemDescription ?? ""
        self.style = item.style ?? ""
        self.sourcedBy = item.sourcedBy ?? ""
        self.acquiredDate = item.acquiredDate
        self.container = item.container ?? ""
        self.compSet = ItemComp.decodeList(item.compSetJSON)
        self.targetPriceText = item.targetPrice.map { currencyFormatter.formatRaw($0) } ?? ""
        self.acquiredPriceText = item.acquiredPrice.map { currencyFormatter.formatRaw($0) } ?? ""
        self.locationBin = item.locationBin ?? ""
        self.consignorId = item.consignorId
        // US-1491: seed locale-formatted so the field's display matches the
        // locale-aware parser (parseSplit). A "."-formatted seed re-parses wrong
        // in comma-decimal locales.
        self.consignmentSplitText = item.consignmentSplitPct
            .map { CurrencyFormatter().formatRaw($0) } ?? ""
        self.measurements = ItemCanvasView.decodeMeasurements(item.measurementsJSON) ?? [:]
    }
}

/// Status transition guard. Mirrors the web's `resolveStatus` policy: a
/// row that's already reached a "terminal" sale state must not regress
/// to a pre-sale status by accident.
public enum StatusGuard {
    /// Terminal states an item shouldn't be silently demoted from.
    public static let terminalStates: Set<String> = [
        "sold", "shipped", "completed", "returned", "archived",
    ]

    /// Pre-sale states. Defined by exclusion: anything not terminal
    /// counts as "pre-sale".
    public static func isPreSale(_ status: String) -> Bool {
        !terminalStates.contains(status)
    }

    /// Returns true iff a transition from `current` to `next` is allowed.
    /// Once a row is in a terminal state, only other terminal states are
    /// reachable — you can flip sold → shipped → completed, but you
    /// can't reset back to cataloged without an explicit override
    /// (which we leave to a future admin tool).
    public static func allows(from current: String, to next: String) -> Bool {
        if current == next { return true }
        if terminalStates.contains(current), !terminalStates.contains(next) {
            return false
        }
        return true
    }
}
