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
    private let service: AspectsProviding

    var phase: Phase = .idle
    var categoryQuery = ""
    var suggestions: [CategorySuggestion] = []
    var isSearching = false

    var selectedCategoryId: String?
    var selectedCategoryName: String?
    var selectedCategoryPath: String?

    var specs: [AspectSpec] = []
    var values: [String: [String]] = [:]
    /// Aspect names whose current value came from the AI fill (for a badge).
    var aiFilled: Set<String> = []

    var isFillingAI = false
    var isSaving = false
    var errorMessage: String?

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

    init(itemId: String, service: AspectsProviding = EbayAspectsService()) {
        self.itemId = itemId
        self.service = service
    }

    // MARK: - Derived

    var missing: [String] { Self.missingRequired(specs: specs, values: values) }
    var hasCategory: Bool { selectedCategoryId != nil }
    var canSave: Bool { hasCategory && !isSaving }

    // MARK: - Lifecycle

    /// Seed from the item's persisted category/aspects, then load its spec.
    func start() async {
        struct Row: Decodable { let ebay_category_id: String?; let ebay_aspects: [String: [String]]? }
        let rows: [Row]? = try? await SupabaseShared.client
            .from("inventory_items")
            .select("ebay_category_id, ebay_aspects")
            .eq("id", value: itemId)
            .limit(1)
            .execute()
            .value
        guard let row = rows?.first, let cat = row.ebay_category_id, !cat.isEmpty else { return }
        selectedCategoryId = cat
        if let existing = row.ebay_aspects { values = existing }
        // AC4: prefetch the current category's aspect spec on open…
        await loadAspects(categoryId: cat)
        // …then deterministically fill any gaps from the item's own data (no AI),
        // mirroring the web composer's prefill-on-load.
        await refillDerived(categoryId: cat)
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

    /// Deterministic, NO-AI gap fill from the item's columns + US-821 attributes
    /// (server maps them through the shared registry + US-823 normalization).
    /// Never overwrites values already present. Best-effort: a failure leaves the
    /// user to fill manually or via AI.
    private func refillDerived(categoryId: String) async {
        do {
            let res = try await service.deriveAspects(
                itemId: itemId, categoryId: categoryId, known: nonEmptyValues()
            )
            values = Self.mergeDerived(into: values, derived: res.derived)
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

    func fillWithAI() async {
        guard let cat = selectedCategoryId else { return }
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
        } catch {
            errorMessage = message(error)
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
        }
        do {
            try await SupabaseShared.client
                .from("inventory_items")
                .update(Patch(ebay_category_id: cat, ebay_aspects: nonEmptyValues()))
                .eq("id", value: itemId)
                .execute()
            return true
        } catch {
            errorMessage = message(error)
            return false
        }
    }

    // MARK: - Field editing (from the view)

    func setSingle(_ value: String, for aspect: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        values[aspect] = trimmed.isEmpty ? [] : [trimmed]
        aiFilled.remove(aspect)
    }

    func toggleMulti(_ value: String, for aspect: String) {
        var current = values[aspect] ?? []
        if let i = current.firstIndex(of: value) { current.remove(at: i) } else { current.append(value) }
        values[aspect] = current
        aiFilled.remove(aspect)
    }

    func isSelected(_ value: String, for aspect: String) -> Bool {
        (values[aspect] ?? []).contains(value)
    }

    func firstValue(for aspect: String) -> String {
        values[aspect]?.first ?? ""
    }

    // MARK: - Pure helpers (unit-tested)

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

    /// Merge server-derived (deterministic, pre-normalized) values into the
    /// current map: only fills aspects that are still blank — a present value
    /// (user-set or carried over) always wins. Pure.
    nonisolated static func mergeDerived(
        into current: [String: [String]], derived: [String: [String]]
    ) -> [String: [String]] {
        var values = current
        for (name, vals) in derived {
            let existing = values[name]?.filter { !$0.isEmpty } ?? []
            guard existing.isEmpty, !vals.isEmpty else { continue }
            values[name] = vals
        }
        return values
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

    private func message(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
