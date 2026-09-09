import Foundation

/// Wire shape for a `sales` row joined to its item title. Decimal columns can
/// arrive from PostgREST as JSON numbers OR numeric strings, so amounts are
/// decoded leniently (the same lesson as inventory `measurements`). A custom
/// init keeps one odd value from throwing the whole row.
struct RemoteSale: Decodable, Identifiable, Equatable {
    let id: String
    let salePrice: Double
    let platformFees: Double
    /// Raw `sale_date` string from the server (date-only or full ISO 8601).
    let saleDate: String
    let buyerUsername: String?
    let itemTitle: String?

    /// Gross PROCEEDS = sale price − marketplace fees. This is deliberately NOT
    /// the unified net profit (``SalePnL/net(_:costBasis:)``): this lightweight
    /// list query carries neither shipping/processing fees nor seller costs nor
    /// cost basis, so it cannot compute net. Named "proceeds" so the same order
    /// is never shown as "net" with a different number than Money/Dashboard.
    var proceeds: Double { salePrice - platformFees }

    /// Parsed `saleDate`. Handles full ISO 8601 (with/without fractional
    /// seconds) and the date-only `YYYY-MM-DD` the legacy pull writes.
    ///
    /// US-3232: goes through the same parser the sync merge uses, so the two
    /// paths that read this one wire field cannot disagree about which shapes
    /// they accept — they did, and the merge path (the one that writes the
    /// cache) was the one missing a shape. Still `.distantPast` rather than
    /// `.now` on failure: an unreadable sale sorts to the bottom instead of
    /// pretending to be today's.
    var date: Date {
        SyncEngine.parseDateOrNil(saleDate) ?? .distantPast
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case salePrice = "sale_price"
        case platformFees = "platform_fees"
        case saleDate = "sale_date"
        case buyerUsername = "buyer_username"
        case inventoryItems = "inventory_items"
    }

    /// The embedded `inventory_items(title)` relation — one item per sale.
    private struct EmbeddedItem: Decodable { let title: String? }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        salePrice = Self.lenientDouble(c, .salePrice) ?? 0
        platformFees = Self.lenientDouble(c, .platformFees) ?? 0
        saleDate = try c.decode(String.self, forKey: .saleDate)
        buyerUsername = try c.decodeIfPresent(String.self, forKey: .buyerUsername)
        // Embed may be absent/null (or, for some relationships, an array we
        // don't expect) — tolerate all of it, the title is non-critical.
        itemTitle = (try? c.decodeIfPresent(EmbeddedItem.self, forKey: .inventoryItems))?.title
    }

    /// Accepts a JSON number or a numeric string ("19.99"); nil otherwise.
    private static func lenientDouble(
        _ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys
    ) -> Double? {
        if let d = try? c.decodeIfPresent(Double.self, forKey: key) { return d }
        if let s = try? c.decodeIfPresent(String.self, forKey: key) { return Double(s) }
        return nil
    }
}
