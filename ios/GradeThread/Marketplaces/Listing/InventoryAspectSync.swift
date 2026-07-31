import Foundation

/// Keeps the eBay item specifics ("Category & eBay specifics") in lock-step with
/// the item's own fields. When the canvas saves a change to brand/size/color/
/// material (or category), any aspect that was auto-derived from those fields
/// (the "Auto" badge) is now stale. This re-derives from the item's *current*
/// fields and overwrites only the inventory-derived (and still-blank) aspects,
/// preserving anything the user typed ("You") or AI filled ("AI"). It mirrors
/// what ``SpecificsEditorModel`` does on open, so the change shows up whether the
/// seller reopens the specifics editor or just publishes (the publish path reads
/// `ebay_aspects` straight from the row).
///
/// No-op when the item has no eBay category selected yet — there are no aspects
/// to reconcile. Best-effort: a failed read/derive/write leaves the existing
/// specifics untouched, so a sync hiccup never blocks or corrupts the save.
@MainActor
enum InventoryAspectSync {
    /// Re-derive and persist the item-owned eBay aspects for `itemId`.
    static func reassertDerivedAspects(
        itemId: String,
        service: AspectsProviding = EbayAspectsService()
    ) async {
        struct Row: Decodable {
            let ebay_category_id: String?
            let ebay_aspects: [String: [String]]?
            let ebay_aspect_sources: [String: String]?
        }
        let rows: [Row]? = try? await SupabaseShared.client
            .from("inventory_items")
            .select("ebay_category_id, ebay_aspects, ebay_aspect_sources")
            .eq("id", value: itemId)
            .limit(1)
            .execute()
            .value
        guard let row = rows?.first, let cat = row.ebay_category_id, !cat.isEmpty else { return }

        let current = row.ebay_aspects ?? [:]
        let sources = (row.ebay_aspect_sources ?? [:]).compactMapValues(AspectProvenance.init(rawValue:))

        // Preserve the user-/AI-owned aspects: passed as `known` so the server
        // re-derives only the item-owned ("Auto") and blank aspects.
        var preserve: [String: [String]] = [:]
        for (name, v) in current {
            let cleaned = v.filter { !$0.isEmpty }
            guard !cleaned.isEmpty else { continue }
            if sources[name] == .manual || sources[name] == .aiExtracted { preserve[name] = cleaned }
        }

        guard let res = try? await service.deriveAspects(
            itemId: itemId, categoryId: cat, known: preserve
        ) else { return }

        var result = SpecificsEditorModel.reconcileDerived(
            into: current, sources: sources, derived: res.derived
        )
        // The main-page column WINS for Brand/Size/Color/Material/Style. The
        // reconcile above deliberately protects manual/AI aspects, which is
        // right for everything else — but those five are projections of a column
        // the seller just edited, so protecting them stranded the edit and the
        // seller had to retype it in the specifics editor too. The server names
        // them (`columnOwned` / `columnCleared`); web does the same thing
        // locally via projectColumnAspects.
        result = SpecificsEditorModel.applyColumnAuthority(
            to: result,
            derived: res.derived,
            columnOwned: res.columnOwned,
            columnCleared: res.columnCleared
        )
        let filled = result.values.compactMapValues { v -> [String]? in
            let cleaned = v.filter { !$0.isEmpty }
            return cleaned.isEmpty ? nil : cleaned
        }

        // Nothing changed → skip the write (avoids a redundant updated_at bump).
        let currentFilled = current.compactMapValues { v -> [String]? in
            let cleaned = v.filter { !$0.isEmpty }
            return cleaned.isEmpty ? nil : cleaned
        }
        guard filled != currentFilled else { return }

        struct Patch: Encodable {
            let ebay_aspects: [String: [String]]
            let ebay_aspect_sources: [String: String]
        }
        _ = try? await SupabaseShared.client
            .from("inventory_items")
            .update(Patch(
                ebay_aspects: filled,
                ebay_aspect_sources: SpecificsEditorModel.storedSources(result.sources, values: filled)
            ))
            .eq("id", value: itemId)
            .execute()
    }
}
