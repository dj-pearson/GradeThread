import SwiftUI

/// Condition-aware repricing suggestions from `/api/flipdesk/pricing/*`.
/// The list endpoint returns raw `repricing_suggestions` rows joined with the
/// item + listing, so these decode with a `.convertFromSnakeCase` decoder
/// (see ``RepricingService``): `current_price_cents` → `currentPriceCents`,
/// `inventory_items` → `inventoryItems`, etc.

struct RepricingSuggestionsResponse: Decodable {
    let suggestions: [RepricingSuggestion]
}

struct RepricingSuggestion: Decodable, Identifiable, Equatable {
    let id: String
    let currentPriceCents: Int
    let suggestedPriceCents: Int
    let compMedianCents: Int?
    let compCount: Int?
    let reasonCode: String
    let message: String?
    let confidence: Double?
    let inventoryItems: ItemRef
    let listings: ListingRef

    struct ItemRef: Decodable, Equatable {
        let title: String?
        let brand: String?
        let gradeValue: Double?
        let gradeLabel: String?
    }

    struct ListingRef: Decodable, Equatable {
        let listingUrl: String?
    }

    // MARK: - Derived

    var reason: RepricingReason { RepricingReason(code: reasonCode) }
    var title: String { inventoryItems.title?.nilIfBlank ?? "Untitled item" }

    /// suggested − current, in cents (positive = raise, negative = cut).
    var deltaCents: Int { suggestedPriceCents - currentPriceCents }

    /// Percent change off the current price (e.g. -0.12 = a 12% cut). nil when
    /// the current price is zero.
    var deltaPct: Double? {
        guard currentPriceCents > 0 else { return nil }
        return Double(deltaCents) / Double(currentPriceCents)
    }
}

/// The three actionable reason codes the scan surfaces (server filters out
/// OK / NO_COMPS before writing a row).
enum RepricingReason: String {
    case underpriced = "UNDERPRICED"
    case overpriced = "OVERPRICED"
    case stale = "STALE"
    case other

    init(code: String) {
        self = RepricingReason(rawValue: code) ?? .other
    }

    var label: String {
        switch self {
        case .underpriced: return "Underpriced"
        case .overpriced:  return "Overpriced"
        case .stale:       return "Stale"
        case .other:       return "Suggestion"
        }
    }

    var systemImage: String {
        switch self {
        case .underpriced: return "arrow.up.right"
        case .overpriced:  return "arrow.down.right"
        case .stale:       return "clock.badge.exclamationmark"
        case .other:       return "tag"
        }
    }

    var tint: Color {
        switch self {
        case .underpriced: return .green
        case .overpriced:  return .orange
        case .stale:       return Color.brandNavy
        case .other:       return .secondary
        }
    }
}

/// `POST /suggestions/:id/apply` success body.
struct RepricingApplyResponse: Decodable {
    let applied: Bool
    let newPrice: Double?
    let ebaySynced: Bool?
}

/// `POST /scan` result counts.
struct RepricingScanResult: Decodable, Equatable {
    let scanned: Int
    let actionable: Int
}

/// One row of the header summary (a reason + how many suggestions carry it).
struct RepricingReasonCount: Identifiable, Equatable {
    let reason: RepricingReason
    let count: Int
    var id: String { reason.rawValue }
}

private extension String {
    var nilIfBlank: String? {
        let t = trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }
}
