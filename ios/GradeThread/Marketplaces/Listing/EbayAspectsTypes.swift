import Foundation

// eBay category "aspects" (a.k.a. item specifics) — the category-driven
// required/recommended/optional fields a listing must carry. Wire models for:
//   • GET  /api/flipdesk/ebay/category/:id/aspects   (raw eBay Taxonomy shape)
//   • POST /api/flipdesk/ai/extract-aspects          (AI value suggestions)
// plus a flattened `AspectSpec` the editor renders. Category suggestion types
// are reused from `Comps/CompsTypes.swift` (CategorySuggestion).
//
// The aspects payload uses eBay's own camelCase keys (localizedAspectName,
// aspectConstraint…), NOT our snake_case — decode it with a bare JSONDecoder.

// MARK: - Raw aspects payload (eBay Taxonomy)

struct CategoryAspectsResponse: Decodable, Equatable {
    let aspects: Container?
    let categoryName: String?

    struct Container: Decodable, Equatable {
        let aspects: [RawAspect]?
    }
    struct RawAspect: Decodable, Equatable {
        let localizedAspectName: String?
        let aspectConstraint: Constraint?
        let aspectValues: [AspectValue]?
    }
    struct Constraint: Decodable, Equatable {
        let aspectMode: String?           // "SELECTION_ONLY" | "FREE_TEXT"
        let aspectRequired: Bool?
        let aspectUsage: String?          // "REQUIRED" | "RECOMMENDED" | "OPTIONAL"
        let itemToAspectCardinality: String? // "SINGLE" | "MULTI"
    }
    struct AspectValue: Decodable, Equatable {
        let localizedValue: String?
    }
}

// MARK: - Flattened editor model

/// One renderable item-specific. `selectionOnly` → dropdown from `allowedValues`;
/// otherwise a free-text field. `multiSelect` → multiple values allowed.
struct AspectSpec: Identifiable, Equatable {
    enum Usage: Equatable { case required, recommended, optional }

    let name: String
    let usage: Usage
    let selectionOnly: Bool
    let multiSelect: Bool
    let allowedValues: [String]

    var id: String { name }
    var isRequired: Bool { usage == .required }

    /// Flatten the raw eBay payload into editor specs, in eBay's order
    /// (already required → recommended → optional from the API). Pure.
    static func parse(_ response: CategoryAspectsResponse) -> [AspectSpec] {
        (response.aspects?.aspects ?? []).compactMap { raw in
            guard let name = raw.localizedAspectName, !name.isEmpty else { return nil }
            let c = raw.aspectConstraint
            let usageRaw = c?.aspectUsage?.uppercased()
            let required = (c?.aspectRequired ?? false) || usageRaw == "REQUIRED"
            let usage: Usage = required
                ? .required
                : (usageRaw == "RECOMMENDED" ? .recommended : .optional)
            return AspectSpec(
                name: name,
                usage: usage,
                selectionOnly: c?.aspectMode?.uppercased() == "SELECTION_ONLY",
                multiSelect: c?.itemToAspectCardinality?.uppercased() == "MULTI",
                allowedValues: (raw.aspectValues ?? []).compactMap(\.localizedValue)
            )
        }
    }
}

// MARK: - AI extract-aspects

struct AspectSuggestion: Decodable, Equatable {
    let values: [String]
    let confidence: Double
    let source: String?
}

struct ExtractAspectsResponse: Decodable, Equatable {
    let categoryId: String?
    /// Keyed by aspect name (e.g. "Brand", "Size Type").
    let suggestions: [String: AspectSuggestion]

    enum CodingKeys: String, CodingKey {
        case categoryId = "category_id"
        case suggestions
    }
}

// MARK: - Deterministic derive (US-824)

/// Response of POST /api/flipdesk/ebay/category/:id/derive-aspects — the no-AI
/// refill the editor uses on a category change. The server maps the item's
/// columns + US-821 canonical attributes through the shared registry (US-822)
/// and normalizes to eBay's allowed values (US-823); `validAspectNames` lets the
/// client classify which existing values carry over vs. don't apply.
struct DeriveAspectsResponse: Decodable, Equatable {
    let categoryId: String?
    /// Aspect name → value(s) filled deterministically (never overwrites known).
    let derived: [String: [String]]
    /// Every aspect name valid for the (new) category.
    let validAspectNames: [String]
}
