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
        /// US-2269: the AI's read of the garment's condition, off the detail and
        /// defect photos. The edge returns this in EXTRACT_FIELDS and both web
        /// intake surfaces apply it; iOS had no case for it, so the review
        /// reported it applied and the column never changed.
        var conditionNotes: String?
        var garmentType: String?
        var garmentCategory: String?
        var itemCategory: String?
        var measurements: [String: Double]?
        var aiFieldSources: [String: SourceEntry]?
        var aiEnrichedAt: String?

        private enum CodingKeys: String, CodingKey {
            case title, brand, size, color, material, style, description
            case conditionNotes = "condition_notes"
            case garmentType = "garment_type"
            case garmentCategory = "garment_category"
            case itemCategory = "item_category"
            case measurements
            case aiFieldSources = "ai_field_sources"
            case aiEnrichedAt = "ai_enriched_at"
        }

        /// Maps one server field name onto its column. Returns false when the
        /// field isn't one we persist.
        ///
        /// The return value is load-bearing: this used to `break` on an unknown
        /// field, so a field the SERVER started returning was dropped in total
        /// silence while the review screen still counted it as applied. The caller
        /// reports what it couldn't map (see ``write``), which is the only way the
        /// next divergence surfaces instead of looking like an AI miss.
        @discardableResult
        mutating func assign(field: String, value: String) -> Bool {
            switch field {
            case "title":            title = value
            case "brand":            brand = value
            case "size":             size = value
            case "color":            color = value
            case "material":         material = value
            case "style":            style = value
            case "description":      description = value
            case "condition_notes":  conditionNotes = value
            case "garment_type":     garmentType = value
            case "garment_category": garmentCategory = value
            case "item_category":    itemCategory = value
            default:                 return false
            }
            return true
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
        var conditionNotes: String? = nil
        var garmentType: String? = nil
        var garmentCategory: String? = nil
        var itemCategory: String? = nil

        private enum CodingKeys: String, CodingKey {
            case title, brand, size, color, material, style, description
            case conditionNotes = "condition_notes"
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
            case "condition_notes":  return conditionNotes
            case "garment_type":     return garmentType
            case "garment_category": return garmentCategory
            case "item_category":    return itemCategory
            default:                 return nil
            }
        }
    }

    // MARK: - Column emptiness (US-2267)
    //
    // Lives here rather than on ``AIExtractStore`` because this enum is
    // nonisolated: the store is @MainActor, so a MainActor-isolated constant can't
    // be read from ``AIExtractInputs`` (a plain value type) without tripping the
    // Swift 6 isolation rules.

    /// The placeholder title a photo-first capture creates the row with
    /// (`PhotoIntakeView.startIntakeFlow`). `title` is NOT NULL, so a brand-new
    /// item's title is this string rather than empty — and treating it as "already
    /// filled" would make the never-overwrite rule refuse to name the item, which
    /// is the exact "Untitled item" dead end US-682 exists to prevent.
    static let placeholderTitle = "Untitled item"

    /// Whether a column currently holds nothing the seller would miss: blank, or
    /// (for `title`) the placeholder.
    static func isUnset(_ value: String?, field: String) -> Bool {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmed.isEmpty { return true }
        return field == "title" && trimmed == placeholderTitle
    }

    /// Every field name the extract endpoint can return, mirrored from
    /// `EXTRACT_FIELDS` in `services/edge-functions/src/lib/ai-extract.ts`. A
    /// parity test asserts each one maps to a ``FieldUpdate`` column, so the
    /// silent-drop bug (US-2269, `condition_notes`) can't come back the next time
    /// the server learns a new field.
    static let serverExtractFields: [String] = [
        "title",
        "brand",
        "style",
        "size",
        "color",
        "material",
        "item_category",
        "garment_type",
        "garment_category",
        "condition_notes",
        "description",
    ]

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
                // `ai_field_sources` is NOT NULL DEFAULT '{}'::jsonb (migration
                // 00024) — reset it to an EMPTY OBJECT, never SQL NULL, which
                // would violate the constraint and fail the whole save (the
                // "null value in column ai_field_sources" error). `ai_enriched_at`
                // is nullable, so clearing it to NULL is fine.
                try container.encode([String: String](), forKey: DynamicKey("ai_field_sources"))
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
            .select("title,brand,size,color,material,style,description,condition_notes,garment_type,garment_category,item_category")
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
        seedTitle: Bool,
        // US-682: an explicit best-available title seed (may be lower-confidence
        // than the auto-applied `fields`), used so a successful extract never
        // leaves the row "Untitled item" even when nothing cleared the auto-apply
        // bar. Falls back to composing from the high-confidence fields applied.
        titleSeed: String? = nil
    ) async throws {
        var update = FieldUpdate()
        var unmapped: [String] = []
        for entry in fields {
            let value = entry.value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty else { continue }
            if !update.assign(field: entry.field, value: value) {
                unmapped.append(entry.field)
            }
        }
        // US-2269: a field the server returns and we can't persist is a real
        // divergence, not a no-op — the review still counts it as applied. Report
        // it instead of dropping it in silence.
        if !unmapped.isEmpty {
            let names = unmapped.sorted().joined(separator: ",")
            await MainActor.run {
                Telemetry.breadcrumb(
                    "AI fill: unmapped extract fields dropped: \(names)",
                    category: "ai-extract"
                )
                Telemetry.event("ai_fill_unmapped_fields", props: [
                    "item_id": itemId,
                    "fields": names,
                ])
            }
        }
        if let measurements, !measurements.isEmpty {
            update.measurements = measurements
        }
        if seedTitle, update.title == nil,
           let seed = seededTitle(brand: update.brand, style: update.style, size: update.size, explicit: titleSeed) {
            update.title = seed
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

    /// US-682 title-seed rule, pure + side-effect-free so the "never land on a
    /// bare Untitled item" guarantee is unit-testable without a network write.
    /// An explicit best-available seed (from the full extraction, any confidence)
    /// wins; otherwise compose brand + style/size from the auto-applied columns.
    /// Returns nil only when there's nothing nameable.
    static func seededTitle(brand: String?, style: String?, size: String?, explicit: String?) -> String? {
        if let explicit = explicit?.trimmingCharacters(in: .whitespacesAndNewlines), !explicit.isEmpty {
            return explicit
        }
        let composed = [brand, style ?? size]
            .compactMap { $0 }
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespaces)
        return composed.isEmpty ? nil : composed
    }

    // MARK: - Canonical attributes (US-826)

    /// The `attributes` + `ai_field_sources` jsonb as they stand, so a
    /// confirm-chip write can read-modify-write without clobbering sibling keys
    /// (e.g. `features`, or core-field sources the auto-apply just wrote).
    /// Tolerant: a missing/odd column degrades to an empty map rather than
    /// throwing the whole read.
    private struct AttributesSnapshot: Decodable {
        var attributes: [String: AnyJSON]
        var aiFieldSources: [String: AnyJSON]

        private enum CodingKeys: String, CodingKey {
            case attributes
            case aiFieldSources = "ai_field_sources"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            attributes = (try? c.decode([String: AnyJSON].self, forKey: .attributes)) ?? [:]
            aiFieldSources = (try? c.decode([String: AnyJSON].self, forKey: .aiFieldSources)) ?? [:]
        }
    }

    private struct AttributeWrite: Encodable {
        let attributes: [String: AnyJSON]
        let aiFieldSources: [String: AnyJSON]
        let aiEnrichedAt: String

        private enum CodingKeys: String, CodingKey {
            case attributes
            case aiFieldSources = "ai_field_sources"
            case aiEnrichedAt = "ai_enriched_at"
        }
    }

    /// Persists the user's confirmed high-value attributes (US-826) onto
    /// `inventory_items.attributes`, recording `ai_field_sources[key] =
    /// { source, confidence, accepted }`. A rejected/cleared field (value nil)
    /// is removed from `attributes` and recorded `accepted: false`. Reads the
    /// current jsonb first and merges so sibling attributes + the core-field
    /// sources written by the auto-apply survive.
    static func writeAttributes(
        itemId: String,
        results: [AIAttributeConfirm.Result]
    ) async throws {
        guard !results.isEmpty else { return }

        let rows: [AttributesSnapshot] = try await SupabaseShared.client
            .from("inventory_items")
            .select("attributes,ai_field_sources")
            .eq("id", value: itemId)
            .limit(1)
            .execute()
            .value
        var attrs = rows.first?.attributes ?? [:]
        var sources = rows.first?.aiFieldSources ?? [:]

        for result in results {
            if let value = result.value, !value.isEmpty {
                attrs[result.key] = .string(value)
            } else {
                attrs.removeValue(forKey: result.key)
            }
            sources[result.key] = .object([
                "source": .string(result.source),
                "confidence": .double(result.confidence),
                "accepted": .bool(result.accepted),
            ])
        }

        let update = AttributeWrite(
            attributes: attrs,
            aiFieldSources: sources,
            aiEnrichedAt: ISO8601DateFormatter().string(from: .now)
        )
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
