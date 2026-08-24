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
    /// Aspect names in this category that are ALREADY editable as main-page item
    /// fields (Brand / Size / Color / Material / Style). The inline specifics
    /// section on the item page skips these so the seller never sees the same
    /// value in two inputs — they share one column and one write-authority.
    /// Optional (not a defaulted `var`): Swift's synthesized Decodable demands a
    /// key for every non-Optional stored property EVEN when it has a default, so
    /// a defaulted array here would break decoding against an older edge build
    /// that doesn't send it — the same trap US-821 hit on AIExtractResponse.
    /// Read it through ``columnBackedNames``.
    let columnBackedAspectNames: [String]?

    /// Never-nil accessor. Empty → show every aspect (previous behaviour).
    var columnBackedNames: [String] { columnBackedAspectNames ?? [] }

    /// US-2839: the same answer keyed BY COLUMN -- item column name
    /// ("brand"/"size"/"color"/"material"/"style") -> the aspect that column
    /// drives in this category. `columnBackedAspectNames` says what to HIDE;
    /// this says what to RENDER, which the flat list cannot: it never states
    /// which of "Size" and "US Shoe Size" the size column owns.
    ///
    /// Optional for the same reason as the flat list -- an older edge build
    /// doesn't send it, and a non-Optional stored property would fail the whole
    /// decode. Read it through ``columnAspectNames``.
    let columnBackedAspects: [String: String]?

    /// Never-nil accessor. Empty -> the item fields render as plain text, which
    /// is exactly the behaviour before this key existed.
    var columnAspectNames: [String: String] { columnBackedAspects ?? [:] }

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

// MARK: - Provenance (US-825)

/// Where an aspect value came from — drives the source badge in the editor and
/// is persisted parallel to `ebay_aspects` in `inventory_items.ebay_aspect_sources`.
/// `unfilled` (an aspect in the spec with no value) is COMPUTED, never stored, so
/// only the three stored cases get a raw value matching the web/edge strings.
enum AspectProvenance: String, Equatable {
    case aiExtracted = "ai_extracted"
    case inventoryDerived = "inventory_derived"
    case manual = "manual"

    /// Short badge label shown next to the field.
    var badgeLabel: String {
        switch self {
        case .aiExtracted: return "AI"
        case .inventoryDerived: return "Auto"
        case .manual: return "You"
        }
    }

    var badgeHint: String {
        switch self {
        case .aiExtracted: return "Filled by AI from your photos/details"
        case .inventoryDerived: return "Derived from this item's fields"
        case .manual: return "You typed this"
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
    /// Aspect name → value(s) filled deterministically. Gap-fill for most
    /// aspects, but the ``columnOwned`` names below are authoritative.
    let derived: [String: [String]]
    /// Every aspect name valid for the (new) category.
    let validAspectNames: [String]
    /// Aspects whose write-authority is a MAIN-PAGE column (Brand, Size, Color,
    /// Material, Style). Their `derived` value must overwrite whatever the
    /// aspect currently holds — even a manual or AI one — because the seller
    /// just edited the column that owns it. Without this an AI-filled Brand
    /// outranked the seller's own correction and had to be retyped in both
    /// places. Matches the web composer's `projectColumnAspects`.
    let columnOwned: [String]
    /// Column-owned aspects whose backing column is now BLANK: the seller
    /// deleted the value, so drop the aspect instead of keeping a stale copy.
    let columnCleared: [String]

    private enum CodingKeys: String, CodingKey {
        case categoryId, derived, validAspectNames, columnOwned, columnCleared
    }

    /// Hand-rolled so an older edge build (no columnOwned/columnCleared) still
    /// decodes — it just falls back to the previous gap-fill-only behaviour.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        categoryId = try c.decodeIfPresent(String.self, forKey: .categoryId)
        derived = try c.decodeIfPresent([String: [String]].self, forKey: .derived) ?? [:]
        validAspectNames = try c.decodeIfPresent([String].self, forKey: .validAspectNames) ?? []
        columnOwned = try c.decodeIfPresent([String].self, forKey: .columnOwned) ?? []
        columnCleared = try c.decodeIfPresent([String].self, forKey: .columnCleared) ?? []
    }

    init(
        categoryId: String?,
        derived: [String: [String]],
        validAspectNames: [String],
        columnOwned: [String] = [],
        columnCleared: [String] = []
    ) {
        self.categoryId = categoryId
        self.derived = derived
        self.validAspectNames = validAspectNames
        self.columnOwned = columnOwned
        self.columnCleared = columnCleared
    }
}
