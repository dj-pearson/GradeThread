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
    public var targetPriceText: String
    public var acquiredPriceText: String

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
        targetPriceText: String = "",
        acquiredPriceText: String = ""
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
        self.targetPriceText = targetPriceText
        self.acquiredPriceText = acquiredPriceText
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
        // category isn't on LocalInventoryItem today — sync engine pulls
        // it as part of item_category later. For now leave nil and let
        // the user pick when they edit.
        self.category = nil
        self.targetPriceText = item.targetPrice.map { currencyFormatter.formatRaw($0) } ?? ""
        self.acquiredPriceText = item.acquiredPrice.map { currencyFormatter.formatRaw($0) } ?? ""
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
