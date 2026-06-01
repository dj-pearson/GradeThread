import Foundation

/// Percentile rollup from the edge `/comps` endpoint — mirrors
/// `BrowseCompsResult.stats` in `ebay-client.ts`. Every percentile is
/// optional because eBay can return zero comparable listings.
struct CompStats: Decodable, Equatable {
    let count: Int
    let currency: String
    let min: Double?
    let p25: Double?
    let median: Double?
    let p75: Double?
    let max: Double?
}

/// `/comps` response. Only `stats` is consumed here; the full `items` /
/// `total` payload is ignored (extra JSON keys decode away cleanly).
struct CompsResponse: Decodable {
    let stats: CompStats
}

/// One eBay taxonomy suggestion from `/category/suggest`.
struct CategorySuggestion: Decodable, Equatable {
    let categoryId: String
    let categoryName: String
    let categoryTreePath: String
}

struct CategorySuggestResponse: Decodable {
    let suggestions: [CategorySuggestion]
}

/// A resolved comps lookup: the percentile stats plus the eBay category
/// path they were drawn from. The path is surfaced so the user can sanity-
/// check that the auto-resolved category actually matches their item.
struct CompsLookup: Equatable {
    let stats: CompStats
    let categoryId: String
    let categoryPath: String
}

/// Abstraction over the two-hop comps lookup so the store is unit-testable
/// with a fake (no network).
@MainActor
protocol CompsProviding {
    /// Resolves an eBay leaf category from the title, then fetches comps
    /// scoped to it (optionally filtered by brand/size). Returns nil when
    /// no category could be resolved — comps can't be searched without
    /// one. Throws on network / HTTP failure.
    func lookup(title: String, brand: String?, size: String?) async throws -> CompsLookup?
}
