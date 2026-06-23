import Foundation

/// String-backed mirrors of the FlipDesk wire enums declared in
/// `src/types/database.ts`. Raw values match exactly so they round-trip
/// through PostgREST without manual translation.

/// `item_category` enum on `inventory_items`.
public enum FlipdeskCategory: String, CaseIterable, Identifiable {
    case clothing
    case shoes
    case watches
    case sportsCards = "sports_cards"
    case collectibles
    case electronics
    case books
    case jewelry
    case bags
    case accessories
    case other

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .clothing:     return "Clothing"
        case .shoes:        return "Shoes"
        case .watches:      return "Watches"
        case .sportsCards:  return "Sports cards"
        case .collectibles: return "Collectibles"
        case .electronics:  return "Electronics"
        case .books:        return "Books"
        case .jewelry:      return "Jewelry"
        case .bags:         return "Bags"
        // Non-garment accessories sold standalone (hats, belts, sunglasses).
        case .accessories:  return "Accessories"
        case .other:        return "Other"
        }
    }
}

/// Clothing classification (`garment_type` / `garment_category` on
/// `inventory_items`). Raw values mirror `GARMENT_TYPES` / `GARMENT_CATEGORIES`
/// in `src/lib/constants.ts` exactly so they round-trip through PostgREST and
/// satisfy the grading validate gate. Only relevant when `item_category ==
/// clothing`.
public enum GarmentClassification {
    public static let types: [String] = [
        "tops", "bottoms", "outerwear", "dresses", "footwear", "accessories",
    ]

    public static let categories: [String] = [
        "t-shirt", "shirt", "blouse", "sweater", "hoodie", "jacket", "coat",
        "jeans", "pants", "shorts", "skirt", "dress", "sneakers", "boots",
        "sandals", "hat", "bag", "belt", "scarf", "other",
    ]

    /// Human label for a raw value: split on "-"/"_" and capitalize each word
    /// ("t-shirt" → "T Shirt"). The stored value is always the raw string.
    public static func label(_ raw: String) -> String {
        raw
            .split(whereSeparator: { $0 == "-" || $0 == "_" || $0 == " " })
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }
}

/// Subset of `item_status` surfaced in the intake form. The full lifecycle
/// includes statuses like 'shipped' / 'sold' that aren't valid starting
/// points — those are reached via downstream flows.
public enum IntakeStatus: String, CaseIterable, Identifiable {
    case sourced
    case cataloged
    case keeping
    case wearing

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .sourced:   return "Sourced (not yet cataloged)"
        case .cataloged: return "Cataloged"
        case .keeping:   return "Keeping (personal)"
        case .wearing:   return "Wearing (personal)"
        }
    }
}

/// `flipdesk_source_type` enum on `sources`.
public enum FlipdeskSourceType: String, CaseIterable, Identifiable {
    case thrift
    case goodwillAuction = "goodwill_auction"
    case estateSale = "estate_sale"
    case wholesale
    case retailArbitrage = "retail_arbitrage"
    case consignment
    case other

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .thrift:           return "Thrift store"
        case .goodwillAuction:  return "Goodwill / auction site"
        case .estateSale:       return "Estate sale"
        case .wholesale:        return "Wholesale / bulk lot"
        case .retailArbitrage:  return "Retail arbitrage"
        case .consignment:      return "Consignment"
        case .other:            return "Other"
        }
    }
}
