import Foundation

// US-745: cross-marketplace Listing Kit wire models. These decode the response
// of the web endpoint POST /api/flipdesk/autolister/platform-fields (US-721),
// so iOS CONSUMES the server's per-platform field/condition/category mapping +
// pre-flight validation (US-720/722/725) instead of re-porting the
// marketplace-specs registry into Swift. The EdgeAPI decoder uses
// `convertFromSnakeCase`, so `listing_id` → `listingId`; the variant keys are
// already camelCase server-side and pass through unchanged.

/// The full endpoint payload: the listing the variants were generated for + one
/// tailored variant per requested no-API marketplace.
struct ListingKitResponse: Decodable, Equatable {
    let listingId: String
    let variants: [PlatformVariant]
}

/// One marketplace's copy-paste-ready listing (Poshmark/Mercari/Grailed/Depop).
struct PlatformVariant: Decodable, Equatable, Identifiable {
    var id: String { platform }
    let platform: String
    let title: String
    let description: String
    /// Platform-mapped condition (US-720). Null when the platform takes no condition.
    let condition: ConditionOption?
    /// Platform-mapped category path (US-722).
    let category: String
    /// Where `category` came from. "query" = an unmapped natural-language fallback.
    let categorySource: String?
    let categoryDepartment: String?
    /// True when the category is unmapped / an unconfirmed AI guess — the kit
    /// surfaces a "pick a category" nudge rather than silently trusting it.
    let categoryNeedsPick: Bool?
    let brand: String?
    let color: String?
    let size: String?
    /// List price in dollars.
    let price: Double
    let tags: [String]
    let confidence: Double
    /// Pre-flight validation for this platform (US-725): block vs warn issues.
    let validation: ValidationResult
    /// Field spec (labels + char limits + required) so the kit can render a live
    /// char-count vs the platform's limit without re-porting the registry.
    let spec: PlatformSpec?
}

/// A condition mapped to one platform's vocabulary.
struct ConditionOption: Decodable, Equatable {
    /// The value the platform stores/expects (API enum, or the visible label).
    let value: String
    /// Human label shown in the kit.
    let label: String
}

/// Pre-flight validation result for one platform.
struct ValidationResult: Decodable, Equatable {
    let platform: String
    /// True when there are no error-level issues (warnings are allowed).
    let ok: Bool
    let issues: [FieldIssue]
}

/// A single validation issue against a field.
struct FieldIssue: Decodable, Equatable, Identifiable {
    let field: String
    /// "error" (a hard blocker) or "warning" (advisory).
    let level: String
    let message: String

    var id: String { "\(field)|\(level)|\(message)" }
    var isError: Bool { level == "error" }
}

/// The platform's field spec — display labels + per-field char limits + the
/// "verify these" provenance note (US-745, served from MARKETPLACE_SPECS).
struct PlatformSpec: Decodable, Equatable {
    let label: String
    let fields: [FieldSpec]
    let maxPhotos: Int
    let sourceNote: String
}

/// One field the kit renders for copy-paste.
struct FieldSpec: Decodable, Equatable, Identifiable {
    let key: String
    let label: String
    let required: Bool
    /// Max characters, when the platform enforces one.
    let maxLength: Int?
    let multiline: Bool?
    let help: String?

    var id: String { key }
}

// MARK: - Kit-facing helpers (pure, unit-tested)

extension PlatformVariant {
    /// The copy-paste value for a spec field key. Grailed names the brand field
    /// "designer" and splits the category into "department" — both map here.
    func value(forField key: String) -> String {
        switch key {
        case "title": return title
        case "description": return description
        case "tags": return tags.joined(separator: " ")
        case "condition": return condition?.label ?? ""
        case "category", "department": return category
        case "brand", "designer": return brand ?? ""
        case "color": return color ?? ""
        case "size": return size ?? ""
        case "price": return String(format: "%.2f", price)
        default: return ""
        }
    }

    /// Error-level issues — the user shouldn't copy these unaware (over-limit,
    /// missing-required, off-allow-list brand, etc.).
    var blockingIssues: [FieldIssue] { validation.issues.filter(\.isError) }

    /// Advisory issues (empty discovery fields like brand/tags).
    var warningIssues: [FieldIssue] { validation.issues.filter { !$0.isError } }

    /// Issues attached to a specific field key (rendered inline under it).
    func issues(forField key: String) -> [FieldIssue] {
        validation.issues.filter { $0.field == key }
    }

    /// "Copy all" payload — every spec field as a labeled block.
    func copyAllText() -> String {
        (spec?.fields ?? [])
            .map { "\($0.label):\n\(value(forField: $0.key))" }
            .joined(separator: "\n\n")
    }
}
