import Foundation

/// One comparable-sale record stored in `inventory_items.comp_set` (jsonb).
/// Mirrors the web `ItemComp` (src/types/database.ts): `price` is required, the
/// rest optional. `Codable` round-trips the jsonb column (snake_case wire keys);
/// `id` is a local-only identity for SwiftUI list editing and is never encoded.
public struct ItemComp: Codable, Equatable, Identifiable {
    public var price: Double
    public var source: String?
    public var url: String?
    public var soldDate: String?
    public var notes: String?

    /// Local identity for `ForEach`/`onDelete` — not part of the wire shape.
    public var id = UUID()

    public init(
        price: Double,
        source: String? = nil,
        url: String? = nil,
        soldDate: String? = nil,
        notes: String? = nil
    ) {
        self.price = price
        self.source = source
        self.url = url
        self.soldDate = soldDate
        self.notes = notes
    }

    enum CodingKeys: String, CodingKey {
        case price, source, url
        case sold_date
        case notes
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Tolerate a price stored as a number or a numeric string.
        if let n = try? c.decode(Double.self, forKey: .price) {
            price = n
        } else if let s = try? c.decode(String.self, forKey: .price), let n = Double(s) {
            price = n
        } else {
            price = 0
        }
        source = try c.decodeIfPresent(String.self, forKey: .source)
        url = try c.decodeIfPresent(String.self, forKey: .url)
        soldDate = try c.decodeIfPresent(String.self, forKey: .sold_date)
        notes = try c.decodeIfPresent(String.self, forKey: .notes)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(price, forKey: .price)
        try c.encodeIfPresent(source, forKey: .source)
        try c.encodeIfPresent(url, forKey: .url)
        try c.encodeIfPresent(soldDate, forKey: .sold_date)
        try c.encodeIfPresent(notes, forKey: .notes)
    }

    /// Decode the stored `comp_set` jsonb (a JSON array string) into comps.
    /// Tolerant: returns [] when the column is null/blank/garbled.
    public static func decodeList(_ json: String?) -> [ItemComp] {
        guard let data = json?.data(using: .utf8), !data.isEmpty else { return [] }
        return (try? JSONDecoder().decode([ItemComp].self, from: data)) ?? []
    }

    /// Encode comps back to a JSON array string for the `comp_set` column, or nil
    /// when empty (so an empty set clears the column).
    public static func encodeList(_ comps: [ItemComp]) -> String? {
        guard !comps.isEmpty else { return nil }
        guard let data = try? JSONEncoder().encode(comps) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
