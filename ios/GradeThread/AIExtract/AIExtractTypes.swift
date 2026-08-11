import Foundation

/// One AI suggestion for a single field. Mirrors the wire shape from
/// `services/edge-functions/src/lib/ai-extract.ts:FieldSuggestion`.
struct FieldSuggestion: Codable, Equatable, Hashable {
    let value: String
    /// 0…1. UI renders as a 0–100% bar.
    let confidence: Double
    /// e.g. "text", "photo:tag", "photo:front". The colon-suffixed forms
    /// indicate which photo slot the signal came from.
    let source: String
}

/// US-821: one captured canonical listing attribute. Mirrors the wire shape
/// from `ai-extract.ts:AttributeSuggestion` — always an array (a single-valued
/// attribute is length 1; `features` is the only multi attribute), with a
/// calibrated confidence + provenance source. These are CANONICAL keys
/// (department, size_type, sleeve_length, …), NOT eBay aspect names — the
/// per-category eBay mapping happens server-side (US-822). The edge service
/// already gap-fill-persists these onto `inventory_items.attributes` during the
/// extract call, so the client decodes them for display/telemetry, not to
/// re-persist.
struct AttributeSuggestion: Codable, Equatable, Hashable {
    let values: [String]
    /// 0…1.
    let confidence: Double
    /// e.g. "text", "photo:tag", "photo:front".
    let source: String
}

/// Conflict surfaced when text + photo extraction disagree on the same
/// field. The review screen exposes both candidates so the user can pick.
struct FieldConflict: Codable, Equatable {
    let field: String
    let textValue: String
    let photoValue: String

    private enum CodingKeys: String, CodingKey {
        case field
        case textValue = "text_value"
        case photoValue = "photo_value"
    }
}

/// Request body for `POST /api/flipdesk/ai/extract`. The edge service accepts
/// either typed photos `[{url, type}]` or a plain `photo_urls` array; we
/// always send typed because we know each slot's intent.
struct AIExtractRequest: Encodable {
    let itemId: String
    let photos: [ExtractPhoto]
    let knownFields: [String: KnownFieldValue]?
    let text: String?

    private enum CodingKeys: String, CodingKey {
        case itemId = "item_id"
        case photos
        case knownFields = "known_fields"
        case text
    }
}

struct ExtractPhoto: Encodable {
    let url: String
    /// Server-side enum value (front / back / tag / detail / defect / …).
    let type: String?
    /// US-2470: the `item_photos.photo_role` qualifier. The edge announces the
    /// photo to the model as "tag: size tag" rather than a bare "tag", which is
    /// what stops it guessing which of three tag shots holds the size.
    var role: String?
}

/// Loosely-typed wrapper because `known_fields` values can be strings,
/// numbers, or booleans on the wire. Today we only send strings, but the
/// type leaves the door open without a breaking change.
enum KnownFieldValue: Encodable {
    case string(String)
    case number(Double)
    case bool(Bool)

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let v): try container.encode(v)
        case .number(let v): try container.encode(v)
        case .bool(let v):   try container.encode(v)
        }
    }
}

/// One-call listing prep: the eBay category + item-specifics the server
/// resolved from the photos and ALREADY PERSISTED onto the item
/// (inventory_items.ebay_category_id / ebay_aspects). The client only needs
/// to display it — the specifics editor reads the saved values.
struct AIExtractEbayBlock: Decodable, Equatable {
    let categoryId: String
    let categoryPath: String?
    /// Merged aspects as persisted (existing values win over AI fills).
    let aspects: [String: [String]]

    private enum CodingKeys: String, CodingKey {
        case categoryId = "category_id"
        case categoryPath = "category_path"
        case aspects
    }
}

/// Successful response from the extract endpoint. The `suggestions` dict
/// keys are field names like "brand" / "size" / "garment_category" — we
/// deliberately decode without snake-to-camel conversion so the keys
/// survive verbatim for the UI + the `ai_field_sources` write.
struct AIExtractResponse: Decodable, Equatable {
    let suggestions: [String: FieldSuggestion]
    let conditionSummary: String?
    let conflicts: [FieldConflict]
    let measurements: [String: Double]?
    let model: String?
    let logId: String?
    /// `-1` means unlimited.
    let actionsRemaining: Int
    /// US-1178: sentinel for "unknown" — e.g. the offline Live Text fallback made
    /// no server call, so the quota isn't known. Distinct from -1 ("unlimited");
    /// any future quota UI should treat this as "not available", not a count.
    static let actionsRemainingUnknown = Int.min
    /// US-2270: now ALWAYS nil from the current edge build. The category +
    /// item-specifics pass runs a SECOND model call (~20s) which doubled the
    /// extract's latency, so it moved to a background task that persists
    /// `ebay_category_id` / `ebay_aspects` on the item when it finishes — see
    /// ``ebayPending``. Kept because an older edge build can still fill it, and
    /// because a filled block means the work is already done.
    /// Defaulted `var` so the synthesized memberwise init keeps working for
    /// callers that build synthetic responses (Live Text fallback, tests).
    var ebay: AIExtractEbayBlock? = nil
    /// US-2270: true when the background category/aspects pass was STARTED for
    /// this item. The client can't read the result inline any more; it shows a
    /// "resolving" state and re-reads the item once the pass has had time to land.
    /// Defaulted so synthetic responses and older edge builds still decode.
    var ebayPending: Bool = false
    /// US-821: canonical listing attributes captured in the SAME extract pass
    /// (department, size_type, sleeve_length, …). Keyed by canonical name. The
    /// server has ALREADY gap-fill-persisted these onto inventory_items, so the
    /// client uses them for display/telemetry only. Defaulted so synthetic
    /// responses (Live Text fallback, tests) and older edge builds still decode.
    var attributes: [String: AttributeSuggestion] = [:]
    /// US-821: the generic eBay category search phrase (item type + department,
    /// no brand/size/color). Persisted server-side so a later category change
    /// can re-resolve without re-running AI.
    var ebayCategoryQuery: String? = nil
    /// US-1527: research-tier product identification (already confidence-
    /// floored server-side). The style suggestion carries source "research"
    /// when it came from here; the review row badges it and discloses the
    /// rationale. Defaulted so synthetic responses / older edges still decode.
    var research: ResearchIdentification? = nil

    private enum CodingKeys: String, CodingKey {
        case suggestions
        case conditionSummary = "condition_summary"
        case conflicts
        case measurements
        case model
        case logId = "log_id"
        case actionsRemaining = "actions_remaining"
        case ebay
        case ebayPending = "ebay_pending"
        case attributes
        case ebayCategoryQuery = "ebay_category_query"
        case research
    }
}

/// US-1527: the research-tier identification block — the AI NAMING the product
/// from its own knowledge (anchored on brand + tag codes + construction
/// details), distinct from observed fields. Shown with an "Identified" badge +
/// the rationale so the user verifies before accepting.
struct ResearchIdentification: Decodable, Equatable {
    let identifiedStyle: String?
    let productLine: String?
    let fabricTechnology: String?
    let msrpEstimateCents: Int?
    let identificationRationale: String?
    let identificationConfidence: Double

    private enum CodingKeys: String, CodingKey {
        case identifiedStyle = "identified_style"
        case productLine = "product_line"
        case fabricTechnology = "fabric_technology"
        case msrpEstimateCents = "msrp_estimate_cents"
        case identificationRationale = "identification_rationale"
        case identificationConfidence = "identification_confidence"
    }
}

extension AIExtractResponse {
    /// Custom decode so the OPTIONAL-with-default fields (`attributes`,
    /// `conflicts`, `ebay`, `ebayCategoryQuery`) tolerate an absent key. Swift's
    /// synthesized Decodable requires every CodingKey for a non-Optional stored
    /// property even when it has a default — so `attributes` (added in US-821)
    /// broke decoding of any response without it (older edge builds, the test
    /// fixtures, Live Text fallbacks). Declared in an extension so the
    /// synthesized memberwise init is preserved for callers/tests.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        suggestions = try c.decode([String: FieldSuggestion].self, forKey: .suggestions)
        conditionSummary = try c.decodeIfPresent(String.self, forKey: .conditionSummary)
        conflicts = try c.decodeIfPresent([FieldConflict].self, forKey: .conflicts) ?? []
        measurements = try c.decodeIfPresent([String: Double].self, forKey: .measurements)
        model = try c.decodeIfPresent(String.self, forKey: .model)
        logId = try c.decodeIfPresent(String.self, forKey: .logId)
        actionsRemaining = try c.decode(Int.self, forKey: .actionsRemaining)
ebay = try c.decodeIfPresent(AIExtractEbayBlock.self, forKey: .ebay)
        ebayPending = try c.decodeIfPresent(Bool.self, forKey: .ebayPending) ?? false
        attributes = try c.decodeIfPresent([String: AttributeSuggestion].self, forKey: .attributes) ?? [:]
        ebayCategoryQuery = try c.decodeIfPresent(String.self, forKey: .ebayCategoryQuery)
        research = try c.decodeIfPresent(ResearchIdentification.self, forKey: .research)
    }
}

/// One row in the review screen. Renderable directly + decoupled from the
/// wire shape so the UI can re-order or filter independently.
struct FieldSuggestionEntry: Identifiable, Equatable, Codable {
    let id: String         // field name, doubles as Identifiable
    let field: String
    let suggestion: FieldSuggestion

    /// Display label for the field. Snake-case keys get title-cased and
    /// underscores become spaces — "garment_category" → "Garment Category".
    var displayLabel: String {
        field
            .split(separator: "_")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    /// Human-readable source label. Knows the canonical `text`,
    /// `photo:<slot>`, `live-text` (on-device OCR, US-177), and `research`
    /// (US-1527 product identification) sources.
    var sourceLabel: String {
        if source == "text" { return "From description" }
        if source == "live-text" { return "On-device OCR" }
        // US-1527: the AI identified the product from its knowledge — the row
        // shows the "Identified" badge; this label backs it up.
        if source == "research" { return "Identified from product knowledge" }
        // US-1217: a conflict-derived row carries the tag (text) candidate; the
        // label tells the user this field disagreed across signals so they pick
        // deliberately rather than inherit a silently-resolved value.
        if source == "conflict:tag" { return "Tag value — conflicts with photo" }
        // US-1530: the photos themselves disagreed on this field — clamped
        // below auto-apply so the user picks deliberately.
        if source == "conflict:photo" { return "Photos disagree on this — verify" }
        if source.hasPrefix("photo:") {
            let slot = String(source.dropFirst("photo:".count))
            return "From \(slot) photo"
        }
        return source
    }

    var source: String { suggestion.source }
    var confidence: Double { suggestion.confidence }
    var value: String { suggestion.value }
}
