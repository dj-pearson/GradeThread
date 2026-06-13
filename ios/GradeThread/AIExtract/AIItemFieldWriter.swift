import Foundation
import Supabase

/// Writes AI-extract suggestions onto an `inventory_items` row, and reverts
/// them. Shared by the intake auto-apply (``AIExtractView``) and the on-canvas
/// review (``AIFillReviewSheet``) so both produce identical column mappings,
/// `ai_field_sources` bookkeeping, and undo semantics.
///
/// All field names are the server column names that arrive verbatim in the
/// extract response (`brand`, `garment_category`, …) — see
/// `AIExtractResponse.suggestions`.
enum AIItemFieldWriter {

    /// One `ai_field_sources` entry — mirrors the web client's shape so the
    /// canvas/specifics editors render the per-field "AI" badge.
    struct SourceEntry: Encodable, Equatable {
        let source: String
        let confidence: Double
        let accepted: Bool
    }

    // MARK: - Sparse fill update

    /// Encodable subset of `inventory_items` the fill writes. Sparse: nil
    /// fields are skipped by the encoder so we never clobber a column we
    /// didn't touch.
    struct FieldUpdate: Encodable {
        var title: String?
        var brand: String?
        var size: String?
        var color: String?
        var material: String?
        var style: String?
        var description: String?
        var garmentType: String?
        var garmentCategory: String?
        var itemCategory: String?
        var measurements: [String: Double]?
        var aiFieldSources: [String: SourceEntry]?
        var aiEnrichedAt: String?

        private enum CodingKeys: String, CodingKey {
            case title, brand, size, color, material, style, description
            case garmentType = "garment_type"
            case garmentCategory = "garment_category"
            case itemCategory = "item_category"
            case measurements
            case aiFieldSources = "ai_field_sources"
            case aiEnrichedAt = "ai_enriched_at"
        }

        mutating func assign(field: String, value: String) {
            switch field {
            case "title":            title = value
            case "brand":            brand = value
            case "size":             size = value
            case "color":            color = value
            case "material":         material = value
            case "style":            style = value
            case "description":      description = value
            case "garment_type":     garmentType = value
            case "garment_category": garmentCategory = value
            case "item_category":    itemCategory = value
            default:
                // Unknown field — silently dropped, matching the web client.
                break
            }
        }
    }

    // MARK: - Snapshot (pre-fill values, for undo)

    /// The AI-editable text columns as they stood BEFORE a fill. Captured so an
    /// undo restores the prior value rather than blindly nulling a column
    /// (notably `title`, which is NOT NULL).
    struct Snapshot: Decodable, Equatable {
        var title: String? = nil
        var brand: String? = nil
        var size: String? = nil
        var color: String? = nil
        var material: String? = nil
        var style: String? = nil
        var description: String? = nil
        var garmentType: String? = nil
        var garmentCategory: String? = nil
        var itemCategory: String? = nil

        private enum CodingKeys: String, CodingKey {
            case title, brand, size, color, material, style, description
            case garmentType = "garment_type"
            case garmentCategory = "garment_category"
            case itemCategory = "item_category"
        }

        /// Prior value for a server column name, nil when that column isn't a
        /// tracked text field.
        func value(for field: String) -> String? {
            switch field {
            case "title":            return title
            case "brand":            return brand
            case "size":             return size
            case "color":            return color
            case "material":         return material
            case "style":            return style
            case "description":      return description
            case "garment_type":     return garmentType
            case "garment_category": return garmentCategory
            case "item_category":    return itemCategory
            default:                 return nil
            }
        }
    }

    // MARK: - Revert update (explicit nulls)

    /// Update that can set columns to an explicit value *or* SQL NULL. The
    /// sparse ``FieldUpdate`` can't null a column (its optionals are skipped),
    /// so undo uses this — it encodes `encodeNil` for restored-nil columns.
    struct RevertUpdate: Encodable {
        /// column name → restored value (nil ⇒ SQL NULL).
        var columns: [String: String?]
        var clearMeasurements: Bool
        var clearAISources: Bool

        private struct DynamicKey: CodingKey {
            var stringValue: String
            var intValue: Int? { nil }
            init(_ value: String) { stringValue = value }
            init?(stringValue: String) { self.stringValue = stringValue }
            init?(intValue: Int) { return nil }
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: DynamicKey.self)
            for (key, value) in columns {
                let codingKey = DynamicKey(key)
                if let value {
                    try container.encode(value, forKey: codingKey)
                } else {
                    try container.encodeNil(forKey: codingKey)
                }
            }
            if clearMeasurements {
                try container.encodeNil(forKey: DynamicKey("measurements"))
            }
            if clearAISources {
                try container.encodeNil(forKey: DynamicKey("ai_field_sources"))
                try container.encodeNil(forKey: DynamicKey("ai_enriched_at"))
            }
        }
    }

    // MARK: - Network

    /// Reads the AI-editable text columns for an item, so a later undo can
    /// restore them. Returns an empty snapshot on any failure (the caller
    /// degrades to nulling the columns).
    static func snapshot(itemId: String) async throws -> Snapshot {
        let rows: [Snapshot] = try await SupabaseShared.client
            .from("inventory_items")
            .select("title,brand,size,color,material,style,description,garment_type,garment_category,item_category")
            .eq("id", value: itemId)
            .limit(1)
            .execute()
            .value
        return rows.first ?? Snapshot()
    }

    /// Writes the accepted field values (+ optional measurements + the merged
    /// `ai_field_sources` map) onto the item. `seedTitle` mirrors US-682: when
    /// no explicit title is being written, seed one from brand/style/size so
    /// the row isn't left as "Untitled item".
    static func write(
        itemId: String,
        fields: [(field: String, value: String)],
        measurements: [String: Double]?,
        sources: [String: SourceEntry],
        seedTitle: Bool
    ) async throws {
        var update = FieldUpdate()
        for entry in fields {
            let value = entry.value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty else { continue }
            update.assign(field: entry.field, value: value)
        }
        if let measurements, !measurements.isEmpty {
            update.measurements = measurements
        }
        if seedTitle, update.title == nil {
            let seed = [update.brand, update.style ?? update.size]
                .compactMap { $0 }
                .joined(separator: " ")
                .trimmingCharacters(in: .whitespaces)
            if !seed.isEmpty { update.title = seed }
        }
        if !sources.isEmpty {
            update.aiFieldSources = sources
            update.aiEnrichedAt = ISO8601DateFormatter().string(from: .now)
        }
        try await SupabaseShared.client
            .from("inventory_items")
            .update(update)
            .eq("id", value: itemId)
            .execute()
    }

    /// Restores columns to their pre-fill values (nil ⇒ SQL NULL), optionally
    /// clearing measurements and the AI-source bookkeeping. Used by undo.
    static func revert(
        itemId: String,
        columns: [String: String?],
        clearMeasurements: Bool,
        clearAISources: Bool
    ) async throws {
        let update = RevertUpdate(
            columns: columns,
            clearMeasurements: clearMeasurements,
            clearAISources: clearAISources
        )
        try await SupabaseShared.client
            .from("inventory_items")
            .update(update)
            .eq("id", value: itemId)
            .execute()
    }
}
