import Foundation

/// eBay item-condition enum used by the publish composer. Raw values are
/// the exact strings eBay's Inventory API expects (and what the edge stores
/// in `listings.ebay_condition`). Mirrors the web composer's dropdown.
enum EbayCondition: String, CaseIterable, Identifiable {
    case new = "NEW"
    case likeNew = "LIKE_NEW"
    case usedExcellent = "USED_EXCELLENT"
    case usedVeryGood = "USED_VERY_GOOD"
    case usedGood = "USED_GOOD"
    case usedAcceptable = "USED_ACCEPTABLE"
    case forParts = "FOR_PARTS_OR_NOT_WORKING"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .new:            return "New with tags"
        case .likeNew:        return "New without tags"
        case .usedExcellent:  return "Pre-owned – Excellent"
        case .usedVeryGood:   return "Pre-owned – Very Good"
        case .usedGood:       return "Pre-owned – Good"
        case .usedAcceptable: return "Pre-owned – Acceptable"
        case .forParts:       return "For parts / not working"
        }
    }

    /// Resolves a server condition string to a case, defaulting to
    /// "Pre-owned – Excellent" (the most common resale condition) when the
    /// value is missing or unrecognized.
    static func resolve(_ raw: String?) -> EbayCondition {
        guard let raw, let match = EbayCondition(rawValue: raw) else {
            return .usedExcellent
        }
        return match
    }
}
