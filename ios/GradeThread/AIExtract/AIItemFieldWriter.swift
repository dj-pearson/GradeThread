import Foundation
import GradeThreadCore
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

        /// Whether this update moves a column whose value can appear in a listing
        /// title (US-1995). Gates the extra pre-write read in ``write`` so an
        /// update that only touches description/measurements costs nothing.
        /// `department` is absent on purpose: it is an `attributes` key here, not
        /// a column, and travels through ``writeAttributes``.
        var touchesSyncableTitleField: Bool {
            brand != nil || size != nil || color != nil || style != nil
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
        // US-1995: capture the pre-write brand/size/color/style BEFORE the update,
        // because afterwards the columns already hold the new value and the diff
        // would be empty. Read here rather than taking it from the caller: two of
        // the three call sites have a Snapshot and one (Size AI on the canvas) does
        // not, and a caller-side snapshot can be several seconds stale by the time
        // the write lands. Four columns, gated on actually writing one of them.
        var priorFields: SyncableFields?
        if update.touchesSyncableTitleField {
            priorFields = try? await syncableFields(itemId: itemId)
        }

        try await SupabaseShared.client
            .from("inventory_items")
            .update(update)
            .eq("id", value: itemId)
            .execute()

        if let priorFields {
            await syncListingTitles(itemId: itemId, before: priorFields, after: update)
        }
    }

    // MARK: - Pipeline status (US-2818)

    /// Move the item forward to `target` after the AI pass, matching where the
    /// web composer leaves an item it has just drafted. Reads the CURRENT status
    /// first rather than trusting a caller's copy: the extract runs in the
    /// background and the seller may have moved the item (or sold it) while it
    /// ran, and ``ItemWorkflow/advanced(current:to:)`` refuses anything that has
    /// left the prep pipeline.
    ///
    /// Returns the new status, or nil when nothing was written.
    @discardableResult
    static func advanceStatus(itemId: String, to target: String) async throws -> String? {
        let rows: [StatusRow] = try await SupabaseShared.client
            .from("inventory_items")
            .select("status")
            .eq("id", value: itemId)
            .limit(1)
            .execute()
            .value
        guard let current = rows.first?.status,
              let next = ItemWorkflow.advanced(current: current, to: target)
        else { return nil }

        try await SupabaseShared.client
            .from("inventory_items")
            .update(StatusUpdate(status: next))
            .eq("id", value: itemId)
            .execute()
        return next
    }

    private struct StatusRow: Decodable { let status: String? }

    private struct StatusUpdate: Encodable { let status: String }

    // MARK: - Description seed (US-2818)

    /// Fill `inventory_items.description` from the per-garment listing template
    /// when the item has none yet. Runs after the AI pass has written brand,
    /// size, colour, material and the measurements, so the template has real
    /// values to interpolate rather than a row of em dashes.
    ///
    /// NEVER overwrites: an existing description is the seller's, or a previous
    /// AI rewrite's, and the template is a starting point rather than an
    /// improvement on either. Returns true when it wrote one.
    @discardableResult
    static func seedDescriptionIfEmpty(itemId: String) async throws -> Bool {
        let rows: [DescriptionSeedRow] = try await SupabaseShared.client
            .from("inventory_items")
            .select(
                "title,brand,size,color,material,style,description,condition_notes,"
                + "garment_type,garment_category,item_category,measurements,"
                + "grade_value,grade_label"
            )
            .eq("id", value: itemId)
            .limit(1)
            .execute()
            .value
        guard let row = rows.first else { return false }
        guard (row.description ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return false }

        let facts = ListingDescriptionTemplate.Facts(
            brand: row.brand ?? "",
            title: row.title ?? "",
            size: row.size ?? "",
            color: row.color ?? "",
            material: row.material ?? "",
            conditionNotes: row.condition_notes ?? "",
            gradeLabel: row.grade_label ?? "",
            gradeValue: row.grade_value,
            measurements: row.measurements ?? [:],
            garmentDescriptor: ListingDescriptionTemplate.garmentDescriptor(
                garmentCategory: row.garment_category,
                garmentType: row.garment_type,
                itemCategory: row.item_category,
                style: row.style,
                title: row.title
            )
        )
        let description = ListingDescriptionTemplate.build(facts: facts)
        guard !description.isEmpty else { return false }

        try await SupabaseShared.client
            .from("inventory_items")
            .update(DescriptionUpdate(description: description))
            .eq("id", value: itemId)
            .execute()
        return true
    }

    private struct DescriptionSeedRow: Decodable {
        let title: String?
        let brand: String?
        let size: String?
        let color: String?
        let material: String?
        let style: String?
        let description: String?
        let condition_notes: String?
        let garment_type: String?
        let garment_category: String?
        let item_category: String?
        let measurements: [String: Double]?
        let grade_value: Double?
        let grade_label: String?

        private enum CodingKeys: String, CodingKey {
            case title, brand, size, color, material, style, description
            case condition_notes, garment_type, garment_category, item_category
            case measurements, grade_value, grade_label
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            title = try c.decodeIfPresent(String.self, forKey: .title)
            brand = try c.decodeIfPresent(String.self, forKey: .brand)
            size = try c.decodeIfPresent(String.self, forKey: .size)
            color = try c.decodeIfPresent(String.self, forKey: .color)
            material = try c.decodeIfPresent(String.self, forKey: .material)
            style = try c.decodeIfPresent(String.self, forKey: .style)
            description = try c.decodeIfPresent(String.self, forKey: .description)
            condition_notes = try c.decodeIfPresent(String.self, forKey: .condition_notes)
            garment_type = try c.decodeIfPresent(String.self, forKey: .garment_type)
            garment_category = try c.decodeIfPresent(String.self, forKey: .garment_category)
            item_category = try c.decodeIfPresent(String.self, forKey: .item_category)
            grade_value = try c.decodeIfPresent(Double.self, forKey: .grade_value)
            grade_label = try c.decodeIfPresent(String.self, forKey: .grade_label)
            // Lenient, like the sync engine's row decode: one odd measurement
            // must not cost the whole description.
            measurements = try? c.decodeIfPresent([String: Double].self, forKey: .measurements)
        }
    }

    private struct DescriptionUpdate: Encodable { let description: String }

    // MARK: - Backwards title sync (US-1995 AC3)
    //
    // An AI fill that CORRECTS brand/size/color/style used to update the item
    // column and leave the listing title still selling the old value - the one
    // field buyers search hardest. US-1891 shipped the fix on the web and the edge
    // and could not reach iOS, because the logic is a TypeScript module and this is
    // a Swift app; the port lives in GradeThreadCore (``TitleSync``) and is pinned
    // to the same behavioural fixture as both JS copies.
    //
    // Not every write is a correction. The intake auto-apply is fill-only
    // (US-2267: `isAutoApplicable` refuses a populated column), so its old value is
    // blank and `changesFromItemDiff` yields nothing - the substitution is a
    // provable no-op and this costs one narrow SELECT. The paths that DO overwrite
    // are Size AI on the canvas (unconditional) and a low-confidence row the seller
    // ticks by hand in the review sheet. Those are the bug.

    private struct SyncableFields: Decodable {
        var brand: String? = nil
        var size: String? = nil
        var color: String? = nil
        var style: String? = nil
    }

    /// One listing that might need its title moved. `title_variants` and
    /// `ai_generated_snapshot` stay as raw jsonb: the port decides WHETHER they
    /// move, this layer owns re-attaching a synced title without dropping the
    /// sibling keys (`label`, `active`) it does not model.
    private struct TitleSyncListing: Decodable {
        let id: String
        let listing_title: String?
        let listing_origin: String?
        let listing_status: String?
        let title_variants: AnyJSON?
        let ai_generated_snapshot: AnyJSON?
    }

    /// Sparse: a nil member is skipped by the synthesized encoder, so a patch that
    /// only flags `needs_review` never nulls the variants.
    private struct TitleSyncPatchBody: Encodable {
        let listing_title: String?
        let title_variants: [AnyJSON]?
        let needs_review: Bool?
    }

    private static func syncableFields(itemId: String) async throws -> SyncableFields {
        let rows: [SyncableFields] = try await SupabaseShared.client
            .from("inventory_items")
            .select("brand,size,color,style")
            .eq("id", value: itemId)
            .limit(1)
            .execute()
            .value
        return rows.first ?? SyncableFields()
    }

    /// Applies the item's field corrections to its listing titles.
    ///
    /// Best-effort and never throwing: the item write has already succeeded, so a
    /// failure here must not make the caller report the whole save as failed and
    /// roll its local mirror back. It breadcrumbs instead.
    ///
    /// Scope is the item's DRAFT and ACTIVE listings. Sold/ended rows are left
    /// alone - their title is a record of what was actually sold, and rewriting it
    /// would falsify history. That matches the web, where the only surfaces that
    /// sync (the composer and bulk edit) can only ever open a draft or a live
    /// listing. ebay-origin rows are refused by the port itself, so the decision
    /// stays in one place.
    private static func syncListingTitles(
        itemId: String,
        before: SyncableFields,
        after: FieldUpdate
    ) async {
        // An absent key in `after` means "unchanged" and must fall back to the
        // before value; reading it as nil would manufacture a change out of every
        // field this write did not touch.
        let changes = TitleSync.changesFromItemDiff(
            before: [
                "brand": before.brand,
                "size": before.size,
                "color": before.color,
                "style": before.style,
            ],
            after: [
                "brand": after.brand ?? before.brand,
                "size": after.size ?? before.size,
                "color": after.color ?? before.color,
                "style": after.style ?? before.style,
            ]
        )
        guard !changes.isEmpty else { return }

        var listings: [TitleSyncListing] = []
        do {
            let rows: [TitleSyncListing] = try await SupabaseShared.client
                .from("listings")
                .select("id,listing_title,listing_origin,listing_status,title_variants,ai_generated_snapshot")
                .eq("inventory_item_id", value: itemId)
                .in("listing_status", values: ["draft", "active"])
                .execute()
                .value
            listings = rows
        } catch {
            await breadcrumbTitleSyncFailure(itemId: itemId, error: error)
            return
        }

        for listing in listings {
            let variants = jsonArray(listing.title_variants)
            let patch = TitleSync.buildTitleSyncPatch(.init(
                baseTitle: listing.listing_title,
                variantTitles: variants?.map { jsonString($0, key: "title") },
                changes: changes,
                snapshotTitle: jsonString(listing.ai_generated_snapshot, key: "title"),
                // A live listing is flagged, never silently rewritten - buyers are
                // already reading those words. It also never ends/relists here.
                isLive: listing.listing_status == "active",
                listingOrigin: listing.listing_origin
            ))
            guard !patch.isEmpty else { continue }

            var syncedVariants: [AnyJSON]?
            if let variants, let titles = patch.variantTitles {
                syncedVariants = rebuildVariants(variants, titles: titles)
            }

            do {
                try await SupabaseShared.client
                    .from("listings")
                    .update(TitleSyncPatchBody(
                        listing_title: patch.listingTitle,
                        title_variants: syncedVariants,
                        needs_review: patch.needsReview
                    ))
                    .eq("id", value: listing.id)
                    .execute()
            } catch {
                await breadcrumbTitleSyncFailure(itemId: itemId, error: error)
            }
        }
    }

    private static func breadcrumbTitleSyncFailure(itemId: String, error: Error) async {
        // Read the description off the actor hop so only Strings cross it.
        let reason = error.localizedDescription
        await MainActor.run {
            Telemetry.breadcrumb(
                "AI fill: listing title sync failed for item \(itemId): \(reason)",
                category: "ai-extract"
            )
        }
    }

    private static func jsonArray(_ value: AnyJSON?) -> [AnyJSON]? {
        guard let value, case let .array(items) = value else { return nil }
        return items
    }

    private static func jsonString(_ value: AnyJSON?, key: String) -> String? {
        guard let value, case let .object(fields) = value,
              case let .string(text)? = fields[key] else { return nil }
        return text
    }

    /// Put each synced title back on its variant object, leaving every other key
    /// (and any entry the port declined to touch) exactly as it was.
    private static func rebuildVariants(_ items: [AnyJSON], titles: [String?]) -> [AnyJSON] {
        zip(items, titles).map { (item, title) -> AnyJSON in
            guard let title, case let .object(fields) = item else { return item }
            var next = fields
            next["title"] = .string(title)
            return .object(next)
        }
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
