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

    private enum CodingKeys: String, CodingKey {
        case suggestions
        case conditionSummary = "condition_summary"
        case conflicts
        case measurements
        case model
        case logId = "log_id"
        case actionsRemaining = "actions_remaining"
    }
}

/// One row in the review screen. Renderable directly + decoupled from the
/// wire shape so the UI can re-order or filter independently.
struct FieldSuggestionEntry: Identifiable, Equatable {
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

    /// `photo:tag` / `photo:front` → "From tag photo" etc. "text" → "From description".
    var sourceLabel: String {
        if source == "text" { return "From description" }
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
