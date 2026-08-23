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
        // them (`columnOwned` / `columnCleared`), which is deliberate: the
        // column-to-aspect mapping lives in ONE place, on the server, so iOS
        // cannot drift from it. Web does the same projection locally via
        // `projectColumnAspectsForSpec` (src/lib/ebay-prefill.ts). This comment
        // used to say `projectColumnAspects`, which was deleted 2026-08-01 with
        // its only caller; the `-ForSpec` suffix is load-bearing, since that
        // function needs a loaded category spec.
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

        // US-2274 AC2: the SECOND store. `listings.item_specifics_override` is
        // what publish and revise read FIRST, so an item-column edit that landed
        // only in `inventory_items.ebay_aspects` did not change what actually
        // ships - which is why a seller had to reopen the specifics editor for
        // their own Size correction to stick.
        await mergeColumnAspectsIntoListings(
            itemId: itemId,
            columnOwned: res.columnOwned,
            filled: filled
        )
    }

    /// The column-owned aspects worth pushing to the listing override.
    ///
    /// PURE, and MERGE-ONLY BY CONSTRUCTION - it can only ever return values to
    /// SET. That is the whole safety argument for AC2, and it is why this does
    /// not take the clear-on-blank shape AC4 describes.
    ///
    /// The story's own 2026-08-03 warning is the reason: writing a clear-on-blank
    /// projection into `item_specifics_override` re-opens the bug fixed in
    /// ea9e27a2. A blank Brand column beside an AI- or hand-typed Brand aspect is
    /// the ORDINARY state of an iOS-created item, so deleting the aspect there
    /// produced "Fill required eBay specifics in the composer: Brand" on a
    /// listing that visibly had Brand. Web reached the same conclusion
    /// independently: `projectColumnAspectsForSpec` bails on a blank column
    /// (`ebay-prefill.ts:503`) precisely so it is overwrite-only.
    ///
    /// So: only names the server marked `columnOwned` - meaning the column
    /// currently HAS a value - and only when that value survived reconciliation.
    /// `columnCleared` is deliberately ignored here; clearing belongs to the
    /// editor, which owns the column inputs.
    nonisolated static func listingOverrideMerge(
        columnOwned: [String],
        filled: [String: [String]]
    ) -> [String: [String]] {
        var out: [String: [String]] = [:]
        for name in columnOwned {
            guard let values = filled[name] else { continue }
            let cleaned = values.filter { !$0.isEmpty }
            guard !cleaned.isEmpty else { continue }
            out[name] = cleaned
        }
        return out
    }

    /// Merge those aspects into every listing row this item still publishes from.
    ///
    /// Scoped to `draft` and `active`, mirroring the US-1995 title-sync decision:
    /// a sold or ended listing's specifics record what was actually sold and must
    /// not be rewritten.
    private static func mergeColumnAspectsIntoListings(
        itemId: String,
        columnOwned: [String],
        filled: [String: [String]]
    ) async {
        let patch = listingOverrideMerge(columnOwned: columnOwned, filled: filled)
        guard !patch.isEmpty else { return }

        struct ListingRow: Decodable {
            let id: String
            let item_specifics_override: [String: [String]]?
        }
        let rows: [ListingRow]? = try? await SupabaseShared.client
            .from("listings")
            .select("id, item_specifics_override")
            .eq("inventory_item_id", value: itemId)
            .in("listing_status", values: ["draft", "active"])
            .execute()
            .value
        guard let rows, !rows.isEmpty else { return }

        for row in rows {
            var merged = row.item_specifics_override ?? [:]
            var changed = false
            for (name, values) in patch where merged[name] != values {
                merged[name] = values
                changed = true
            }
            guard changed else { continue }
            struct Patch: Encodable { let item_specifics_override: [String: [String]] }
            _ = try? await SupabaseShared.client
                .from("listings")
                .update(Patch(item_specifics_override: merged))
                .eq("id", value: row.id)
                .execute()
        }
    }
}
