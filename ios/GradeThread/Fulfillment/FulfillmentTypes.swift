import Foundation

/// Wire shape for a `sales` row surfaced in the shipping/fulfillment queue
/// (US-669). A sale "needs shipping" when `shipped_at` is null. Decimal
/// columns can arrive from PostgREST as JSON numbers OR numeric strings, so
/// amounts are decoded leniently (same lesson as ``RemoteSale``); one odd
/// value can't throw the whole row.
struct FulfillmentOrder: Decodable, Identifiable, Equatable {
    let id: String
    let salePrice: Double
    /// Shipping-label cost already ingested from eBay (SHIPPING_LABEL). Feeds
    /// the item P&L; shown in the queue so the daily ship cost is visible.
    let shippingCost: Double
    let buyerUsername: String?
    let itemTitle: String?
    let trackingNumber: String?
    /// Raw `sold_at` (preferred) — drives oldest-first ship-by priority.
    let soldAtRaw: String?
    /// Raw `sale_date` (date-only or ISO 8601) — fallback ordering key.
    let saleDateRaw: String
    /// Raw `shipped_at`; non-nil means the order has already shipped and is
    /// filtered out of the needs-shipping queue.
    let shippedAtRaw: String?

    /// True once the order has a `shipped_at` timestamp.
    var isShipped: Bool {
        guard let shippedAtRaw, !shippedAtRaw.isEmpty else { return false }
        return true
    }

    /// When the order sold — `sold_at` if present, else `sale_date`. Used to
    /// rank the queue so the oldest (most overdue) order ships first.
    var soldDate: Date {
        PayoutDateFormat.parse(soldAtRaw)
            ?? PayoutDateFormat.parse(saleDateRaw)
            ?? .distantPast
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case salePrice = "sale_price"
        case shippingCost = "shipping_cost"
        case buyerUsername = "buyer_username"
        case trackingNumber = "tracking_number"
        case soldAt = "sold_at"
        case saleDate = "sale_date"
        case shippedAt = "shipped_at"
        case inventoryItems = "inventory_items"
    }

    /// The embedded `inventory_items(title)` relation — one item per sale.
    private struct EmbeddedItem: Decodable { let title: String? }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        salePrice = Self.lenientDouble(c, .salePrice) ?? 0
        shippingCost = Self.lenientDouble(c, .shippingCost) ?? 0
        buyerUsername = try c.decodeIfPresent(String.self, forKey: .buyerUsername)
        trackingNumber = try c.decodeIfPresent(String.self, forKey: .trackingNumber)
        soldAtRaw = try c.decodeIfPresent(String.self, forKey: .soldAt)
        saleDateRaw = (try? c.decode(String.self, forKey: .saleDate)) ?? ""
        shippedAtRaw = try c.decodeIfPresent(String.self, forKey: .shippedAt)
        // The embed may be absent/null — the title is non-critical.
        itemTitle = (try? c.decodeIfPresent(EmbeddedItem.self, forKey: .inventoryItems))?.title
    }

    /// Memberwise initializer for tests + previews (the custom `init(from:)`
    /// suppresses the synthesized one).
    init(
        id: String,
        salePrice: Double,
        shippingCost: Double = 0,
        buyerUsername: String? = nil,
        itemTitle: String? = nil,
        trackingNumber: String? = nil,
        soldAtRaw: String? = nil,
        saleDateRaw: String = "",
        shippedAtRaw: String? = nil
    ) {
        self.id = id
        self.salePrice = salePrice
        self.shippingCost = shippingCost
        self.buyerUsername = buyerUsername
        self.itemTitle = itemTitle
        self.trackingNumber = trackingNumber
        self.soldAtRaw = soldAtRaw
        self.saleDateRaw = saleDateRaw
        self.shippedAtRaw = shippedAtRaw
    }

    /// Accepts a JSON number or a numeric string ("4.99"); nil otherwise.
    private static func lenientDouble(
        _ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys
    ) -> Double? {
        if let d = try? c.decodeIfPresent(Double.self, forKey: key) { return d }
        if let s = try? c.decodeIfPresent(String.self, forKey: key) { return Double(s) }
        return nil
    }
}
