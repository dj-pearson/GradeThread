import SwiftUI

/// View-model for the eBay Category + Item Specifics editor. Loads the item's
/// existing category/aspects, lets the user search/select a category, fetches
/// its aspect spec, fills values manually or with AI, and persists to
/// `inventory_items.ebay_category_id` + `ebay_aspects` (the mirror the publish
/// path already reads). Pattern mirrors `CompsStore` (@MainActor @Observable).
@MainActor
@Observable
final class SpecificsEditorModel {

    enum Phase: Equatable {
        case idle
        case loadingAspects
        case ready
        case failed(String)
    }

    let itemId: String
    /// When the item has a live (revisable) eBay listing, saving the specifics
    /// also pushes them to that listing via the revise endpoint. nil for items
    /// without a live GradeThread-published listing.
    private let liveListingId: String?
    private let service: AspectsProviding

    var phase: Phase = .idle
    var categoryQuery = ""
    var suggestions: [CategorySuggestion] = []
    var isSearching = false

    var selectedCategoryId: String?
    var selectedCategoryName: String?
    var selectedCategoryPath: String?
    /// US-1500: the category persisted at load (or last successful save), so
    /// `save()` can tell whether the category actually CHANGED — a change must
    /// also update `listings.platform_category_id` and force the revise resync,
    /// or the live listing (and a later relist) stays in the old category.
    private var originalCategoryId: String?

    var specs: [AspectSpec] = []
    var values: [String: [String]] = [:]
    /// US-825: per-aspect provenance (ai_extracted | inventory_derived | manual)
    /// parallel to `values`. Drives the source badge; `unfilled` is computed.
    var sources: [String: AspectProvenance] = [:]
    /// Aspect names whose current value came from the AI fill (for a badge).
    var aiFilled: Set<String> = []

    var isFillingAI = false
    var isSaving = false
    var errorMessage: String?

    /// US-1513: the persisted baseline the current edits are compared against —
    /// snapshotted after `start()` finishes (so the deterministic auto-refill,
    /// which is re-derived for free on every open, doesn't count as dirty) and
    /// re-snapshotted after a successful save. Drives the back-swipe guard.
    private var baselineValues: [String: [String]] = [:]
    private var baselineCategoryId: String?

    /// US-1513: unsaved work exists — a manual/AI aspect edit or a category
    /// change since the baseline. Backing out now would silently lose it.
    var isDirty: Bool {
        selectedCategoryId != baselineCategoryId || nonEmptyValues() != baselineValues
    }

    private func rebaseline() {
        baselineValues = nonEmptyValues()
        baselineCategoryId = selectedCategoryId
    }

    /// US-824: a category change that would discard specifics, held until the
    /// user confirms. `nil` when there's nothing to confirm. Drives the
    /// confirm-before-discard alert in the view.
    struct PendingCategoryChange: Equatable {
        let suggestion: CategorySuggestion
        let newSpecs: [AspectSpec]
        let newCategoryName: String?
        /// Values that carry over to the new category (kept as-is).
        let kept: [String: [String]]
        /// Previously-set values that don't apply to the new category.
        let dropped: [String: [String]]
    }
    var pendingCategoryChange: PendingCategoryChange?

    init(
        itemId: String,
        liveListingId: String? = nil,
        service: AspectsProviding = EbayAspectsService()
    ) {
        self.itemId = itemId
        self.liveListingId = liveListingId
        self.service = service
    }

    // MARK: - Derived

    var missing: [String] { Self.missingRequired(specs: specs, values: values) }
    var hasCategory: Bool { selectedCategoryId != nil }
    var canSave: Bool { hasCategory && !isSaving }

    // MARK: - Lifecycle

    /// Seed from the item's persisted category/aspects, then load its spec.
    func start() async {
        struct Row: Decodable {
            let ebay_category_id: String?
            let ebay_aspects: [String: [String]]?
            // US-825: persisted provenance parallel to ebay_aspects.
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
        selectedCategoryId = cat
        originalCategoryId = cat  // US-1500: baseline for change detection in save()
        if let existing = row.ebay_aspects { values = existing }
        // US-825: restore the saved source badges (AI / Auto / You).
        if let savedSources = row.ebay_aspect_sources {
            sources = savedSources.compactMapValues(AspectProvenance.init(rawValue:))
        }
        // AC4: prefetch the current category's aspect spec on open…
        await loadAspects(categoryId: cat)
        // …then deterministically fill any gaps from the item's own data (no AI),
        // mirroring the web composer's prefill-on-load.
        await refillDerived(categoryId: cat)
        // US-1513: everything up to here is loaded/derived, not user work.
        rebaseline()
    }

    /// US-1407: retry the aspect-spec load after a `.failed` phase. The view's
    /// `.task` fires `start()` only once, so a transient failure previously left
    /// the editor on a dead-end error with no recovery (the user had to back out
    /// and reopen). Re-runs the load for the already-selected category, or the
    /// full `start()` if none has been resolved yet.
    func reload() async {
        if let cat = selectedCategoryId, !cat.isEmpty {
            await loadAspects(categoryId: cat)
            // Only refill once the spec actually loaded — don't paper over a
            // still-failed load.
            if phase == .ready { await refillDerived(categoryId: cat) }
        } else {
            await start()
        }
    }

    func search() async {
        let q = categoryQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard q.count >= 2 else { suggestions = []; return }
        isSearching = true
        defer { isSearching = false }
        do { suggestions = try await service.suggestCategories(q) }
        catch { errorMessage = message(error) }
    }

    /// US-824: a category change is a deterministic refill, never a blind wipe.
    /// We fetch the NEW category's spec first; values still valid carry over,
    /// gaps are refilled from the item's own data (no AI), and any value that
    /// doesn't apply to the new category is surfaced for confirm-before-discard.
    func select(_ suggestion: CategorySuggestion) async {
        suggestions = []
        categoryQuery = ""
        guard suggestion.categoryId != selectedCategoryId else {
            // Re-selected the current category — nothing to refill or discard.
            selectedCategoryName = suggestion.categoryName
            selectedCategoryPath = suggestion.categoryTreePath
            return
        }
        // Load the new spec WITHOUT committing the switch yet, so we can tell the
        // user which specifics won't carry over before dropping anything.
        phase = .loadingAspects
        let newSpecs: [AspectSpec]
        let newName: String?
        do {
            let res = try await service.aspects(categoryId: suggestion.categoryId)
            newSpecs = AspectSpec.parse(res)
            newName = res.categoryName
        } catch {
            phase = .failed(message(error))
            return
        }
        let part = Self.partitionForCategoryChange(current: values, newSpecs: newSpecs)
        if !part.dropped.isEmpty {
            // Hold the change behind a confirm-before-discard prompt.
            pendingCategoryChange = PendingCategoryChange(
                suggestion: suggestion, newSpecs: newSpecs, newCategoryName: newName,
                kept: part.kept, dropped: part.dropped
            )
            phase = .ready
            return
        }
        await applyCategoryChange(
            suggestion: suggestion, newSpecs: newSpecs, newName: newName, kept: part.kept
        )
    }

    /// Commit a (possibly confirmed) category change: keep still-valid values,
    /// drop the rest, then deterministically refill gaps from the item — no AI.
    private func applyCategoryChange(
        suggestion: CategorySuggestion, newSpecs: [AspectSpec], newName: String?,
        kept: [String: [String]]
    ) async {
        selectedCategoryId = suggestion.categoryId
        selectedCategoryName = suggestion.categoryName.isEmpty ? newName : suggestion.categoryName
        selectedCategoryPath = suggestion.categoryTreePath
        specs = newSpecs
        values = kept
        aiFilled = aiFilled.intersection(Set(kept.keys))
        // US-825: drop provenance for values that didn't carry over.
        sources = sources.filter { kept.keys.contains($0.key) }
        phase = .ready
        await refillDerived(categoryId: suggestion.categoryId)
    }

    /// Confirm a held category change (the user accepted discarding the values
    /// that don't apply to the new category).
    func confirmCategoryChange() async {
        guard let pending = pendingCategoryChange else { return }
        pendingCategoryChange = nil
        await applyCategoryChange(
            suggestion: pending.suggestion, newSpecs: pending.newSpecs,
            newName: pending.newCategoryName, kept: pending.kept
        )
    }

    /// Cancel a held category change — keep the current category and all values.
    func cancelCategoryChange() {
        pendingCategoryChange = nil
    }

    /// Deterministic, NO-AI re-derive from the item's columns + US-821 attributes
    /// (server maps them through the shared registry + US-823 normalization). The
    /// item's own fields OWN their aspects: a value that is blank OR previously
    /// auto-derived ("Auto") is refreshed from the current item data, so editing
    /// brand/size/color/material on the item flows into the specifics here on
    /// open. Anything the user typed ("You") or AI filled ("AI") is preserved —
    /// it's passed to the server as `known` so those aspects are never re-derived.
    /// Best-effort: a failure leaves the user to fill manually or via AI.
    private func refillDerived(categoryId: String) async {
        do {
            let res = try await service.deriveAspects(
                itemId: itemId, categoryId: categoryId, known: preservedValues()
            )
            let result = Self.reconcileDerived(into: values, sources: sources, derived: res.derived)
            values = result.values
            sources = result.sources
        } catch {
            // Non-fatal — the spec is loaded and the user can still fill manually.
        }
    }

    private func loadAspects(categoryId: String) async {
        phase = .loadingAspects
        do {
            let res = try await service.aspects(categoryId: categoryId)
            specs = AspectSpec.parse(res)
            if selectedCategoryName == nil { selectedCategoryName = res.categoryName }
            phase = .ready
        } catch {
            phase = .failed(message(error))
        }
    }

    /// US-1190: returns the number of specifics newly filled (0 on a no-op or
    /// error), so the view can give distinct feedback instead of a flat haptic.
    @discardableResult
    func fillWithAI() async -> Int {
        guard let cat = selectedCategoryId else { return 0 }
        isFillingAI = true
        defer { isFillingAI = false }
        do {
            let res = try await service.extractAspects(
                itemId: itemId, categoryId: cat,
                categoryPath: selectedCategoryPath, known: nonEmptyValues()
            )
            let merged = Self.mergeAISuggestions(
                into: values, suggestions: res.suggestions, specs: specs, minConfidence: 0.6
            )
            values = merged.values
            aiFilled.formUnion(merged.filled)
            // US-825: AI-filled aspects carry ai_extracted provenance.
            for name in merged.filled { sources[name] = .aiExtracted }
            return merged.filled.count
        } catch {
            errorMessage = message(error)
            return 0
        }
    }

    /// Persist category + aspects to the item. Returns true on success.
    func save() async -> Bool {
        guard let cat = selectedCategoryId else { return false }
        isSaving = true
        defer { isSaving = false }
        struct Patch: Encodable {
            let ebay_category_id: String
            let ebay_aspects: [String: [String]]
            // US-825: provenance parallel to ebay_aspects, pruned to filled aspects.
            let ebay_aspect_sources: [String: String]
        }
        // US-1500: did the category actually change? A change must also reach the
        // listing row + force the revise resync (below).
        let categoryChanged = cat != originalCategoryId
        let filled = nonEmptyValues()
        do {
            try await SupabaseShared.client
                .from("inventory_items")
                .update(Patch(
                    ebay_category_id: cat,
                    ebay_aspects: filled,
                    ebay_aspect_sources: Self.storedSources(sources, values: filled)
                ))
                .eq("id", value: itemId)
                .execute()
        } catch {
            errorMessage = message(error)
            return false
        }
        // US-1513: the item row is persisted — from here on, backing out loses
        // nothing (the listing mirror / revise below surface their own errors).
        rebaseline()
        // US-1500: mirror the new category onto the item's GT-origin listing row(s)
        // — draft OR active. The edge prefers `listings.platform_category_id` over
        // `inventory_items.ebay_category_id` at BOTH publish and revise, so without
        // this a re-categorized item's live listing (and even a later relist) stayed
        // in the OLD category and the aspect re-PUT validated against the old spec.
        if categoryChanged {
            struct CategoryPatch: Encodable { let platform_category_id: String }
            do {
                try await SupabaseShared.client
                    .from("listings")
                    .update(CategoryPatch(platform_category_id: cat))
                    .eq("inventory_item_id", value: itemId)
                    .eq("listing_origin", value: "gradethread")
                    .execute()
            } catch {
                errorMessage =
                    "Saved on your device, but couldn't update the listing category: \(message(error))"
                return false
            }
        }
        // The DB now reflects the new category, so re-baseline (a re-save with no
        // further change won't redundantly re-flag / re-resync).
        originalCategoryId = cat
        // Push the edit to the live eBay listing. Without this, an aspect edit
        // (e.g. Inseam) only reached inventory_items.ebay_aspects, which a
        // previously-written item_specifics_override on the listing shadowed — so
        // the change never reached eBay. A push failure keeps the sheet open with
        // an explanatory message; the local save already persisted.
        if let listingId = liveListingId {
            switch await resyncSpecifics(
                listingId: listingId, filled: filled, categoryChanged: categoryChanged
            ) {
            case .revised:
                return true
            case .noOfferId:
                errorMessage =
                    "Saved on your device, but this listing has no eBay offer to update."
                return false
            case .failed(let msg):
                errorMessage =
                    "Saved on your device, but the eBay update failed: \(msg)"
                return false
            }
        }
        return true
    }

    /// Mirror the edited specifics onto the listing's canonical
    /// `item_specifics_override` (the map the revise endpoint reads FIRST), then
    /// revise. We MERGE onto the existing override so listing-only aspects we
    /// don't surface in this editor — notably the "Condition Grade" item specific
    /// — are preserved rather than dropped on the push.
    private func resyncSpecifics(
        listingId: String, filled: [String: [String]], categoryChanged: Bool
    ) async -> ReviseOutcome {
        struct Row: Decodable { let item_specifics_override: [String: [String]]? }
        let rows: [Row]? = try? await SupabaseShared.client
            .from("listings")
            .select("item_specifics_override")
            .eq("id", value: listingId)
            .limit(1)
            .execute()
            .value
        var merged = rows?.first?.item_specifics_override ?? [:]
        for (key, value) in filled { merged[key] = value }

        struct Patch: Encodable { let item_specifics_override: [String: [String]] }
        do {
            try await SupabaseShared.client
                .from("listings")
                .update(Patch(item_specifics_override: merged))
                .eq("id", value: listingId)
                .execute()
        } catch {
            // Couldn't refresh the canonical override — revise would push stale
            // aspects, so surface the failure instead of a misleading success.
            return .failed(message: message(error))
        }
        // US-1500: when the category changed, force `resync_ebay_fields` so the
        // offer-side category PUT runs and the aspect re-PUT validates against the
        // NEW category spec (the edge only re-PUTs the category when this is set).
        return await EbayPublishService().revise(
            listingId: listingId, syncPhotos: true, resyncFields: categoryChanged
        )
    }

    // MARK: - Field editing (from the view)

    func setSingle(_ value: String, for aspect: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        values[aspect] = trimmed.isEmpty ? [] : [trimmed]
        aiFilled.remove(aspect)
        markManualOrClear(aspect)
    }

    func toggleMulti(_ value: String, for aspect: String) {
        var current = values[aspect] ?? []
        if let i = current.firstIndex(of: value) { current.remove(at: i) } else { current.append(value) }
        values[aspect] = current
        aiFilled.remove(aspect)
        markManualOrClear(aspect)
    }

    /// US-825: a manual edit is `manual` provenance; clearing the field drops it.
    private func markManualOrClear(_ aspect: String) {
        if (values[aspect]?.contains { !$0.isEmpty }) == true {
            sources[aspect] = .manual
        } else {
            sources[aspect] = nil
        }
    }

    /// Provenance to badge for an aspect — only when it actually has a value.
    func provenance(for aspect: String) -> AspectProvenance? {
        guard (values[aspect]?.contains { !$0.isEmpty }) == true else { return nil }
        return sources[aspect]
    }

    func isSelected(_ value: String, for aspect: String) -> Bool {
        (values[aspect] ?? []).contains(value)
    }

    func firstValue(for aspect: String) -> String {
        values[aspect]?.first ?? ""
    }

    // MARK: - Pure helpers (unit-tested)

    /// US-825: the source map to persist — pruned to aspects that actually have
    /// a value, encoded as the shared provenance strings (so a cleared field
    /// never leaves a stale source behind). Pure.
    nonisolated static func storedSources(
        _ sources: [String: AspectProvenance], values: [String: [String]]
    ) -> [String: String] {
        var out: [String: String] = [:]
        for (name, prov) in sources where (values[name]?.contains { !$0.isEmpty }) == true {
            out[name] = prov.rawValue
        }
        return out
    }

    /// Required aspects with no non-empty value yet.
    nonisolated static func missingRequired(specs: [AspectSpec], values: [String: [String]]) -> [String] {
        specs
            .filter { $0.isRequired && (values[$0.name]?.contains { !$0.isEmpty } != true) }
            .map(\.name)
    }

    /// US-824: partition current values against a NEW category's spec. Values
    /// whose aspect name still exists carry over (`kept`); the rest don't apply
    /// to the new category (`dropped`) and are surfaced for confirm-before-
    /// discard. Empty/blank values are ignored (nothing to keep or lose). Pure.
    nonisolated static func partitionForCategoryChange(
        current: [String: [String]], newSpecs: [AspectSpec]
    ) -> (kept: [String: [String]], dropped: [String: [String]]) {
        let valid = Set(newSpecs.map(\.name))
        var kept: [String: [String]] = [:]
        var dropped: [String: [String]] = [:]
        for (name, values) in current {
            let nonEmpty = values.filter { !$0.isEmpty }
            guard !nonEmpty.isEmpty else { continue }
            if valid.contains(name) { kept[name] = values } else { dropped[name] = nonEmpty }
        }
        return (kept, dropped)
    }

    /// Reconcile server-derived (deterministic, pre-normalized) values into the
    /// current map+sources. The item's own fields own their aspects, so a derived
    /// value overwrites an aspect that is blank OR already `inventory_derived`
    /// ("Auto") — and stamps it `inventory_derived`. A `manual` ("You") or
    /// `ai_extracted` ("AI") value is never touched (the caller also excludes
    /// those from the server `known` so they aren't re-derived). Pure.
    nonisolated static func reconcileDerived(
        into current: [String: [String]],
        sources: [String: AspectProvenance],
        derived: [String: [String]]
    ) -> (values: [String: [String]], sources: [String: AspectProvenance]) {
        var values = current
        var newSources = sources
        for (name, vals) in derived {
            let nonEmpty = vals.filter { !$0.isEmpty }
            guard !nonEmpty.isEmpty else { continue }
            let existing = values[name]?.filter { !$0.isEmpty } ?? []
            let prov = sources[name]
            guard existing.isEmpty || prov == .inventoryDerived else { continue }
            values[name] = nonEmpty
            newSources[name] = .inventoryDerived
        }
        return (values, newSources)
    }

    /// Merge AI suggestions into the current values: only fills aspects that are
    /// still blank, meet the confidence floor, and exist in the spec; honors
    /// single-vs-multi and selection-only (filtered to allowed values).
    nonisolated static func mergeAISuggestions(
        into current: [String: [String]],
        suggestions: [String: AspectSuggestion],
        specs: [AspectSpec],
        minConfidence: Double
    ) -> (values: [String: [String]], filled: Set<String>) {
        var values = current
        var filled: Set<String> = []
        let specByName = Dictionary(specs.map { ($0.name, $0) }, uniquingKeysWith: { a, _ in a })
        for (name, suggestion) in suggestions {
            guard suggestion.confidence >= minConfidence, !suggestion.values.isEmpty,
                  let spec = specByName[name] else { continue }
            let existing = values[name]?.filter { !$0.isEmpty } ?? []
            guard existing.isEmpty else { continue } // never overwrite user input
            var picked = spec.multiSelect ? suggestion.values : Array(suggestion.values.prefix(1))
            if spec.selectionOnly, !spec.allowedValues.isEmpty {
                picked = picked.filter { spec.allowedValues.contains($0) }
            }
            guard !picked.isEmpty else { continue }
            values[name] = picked
            filled.insert(name)
        }
        return (values, filled)
    }

    private func nonEmptyValues() -> [String: [String]] {
        values.compactMapValues { v in
            let cleaned = v.filter { !$0.isEmpty }
            return cleaned.isEmpty ? nil : cleaned
        }
    }

    /// The user-/AI-owned aspects (`manual` + `ai_extracted`) with a non-empty
    /// value — passed to the server as `known` so a re-derive refreshes only the
    /// item-owned ("Auto") and blank aspects and never clobbers these.
    private func preservedValues() -> [String: [String]] {
        var out: [String: [String]] = [:]
        for (name, v) in values {
            let cleaned = v.filter { !$0.isEmpty }
            guard !cleaned.isEmpty else { continue }
            if sources[name] == .manual || sources[name] == .aiExtracted { out[name] = cleaned }
        }
        return out
    }

    private func message(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
