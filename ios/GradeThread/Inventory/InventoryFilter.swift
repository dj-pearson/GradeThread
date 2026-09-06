import Foundation

/// Pure helpers used by `InventoryListView` to bridge SwiftData @Query
/// results to the user-visible list. Kept separate so the predicate
/// semantics (which fields a search query hits, which statuses belong
/// to which stage) can be unit-tested without any SwiftUI plumbing.
public enum InventoryFilter {

    /// Applies stage + (optional) graded-only + search + sort in that order.
    /// The pipeline order matters: stage filtering is the cheapest cut,
    /// graded-only narrows further, search is substring-based on a small set
    /// of fields, sort is the final pass.
    static func apply(
        _ items: [LocalInventoryItem],
        stage: InventoryStage,
        search: String,
        sort: SortOption,
        gradedOnly: Bool = false
    ) -> [LocalInventoryItem] {
        var staged = items.filter { stage.matchingStatuses.contains($0.status) }
        if gradedOnly {
            staged = staged.filter { $0.gradeValue != nil }
        }
        let searched = filter(staged, search: search)
        return searched.sorted(by: sort.isOrdered)
    }

    /// Full pipeline with the advanced ``InventoryFilterCriteria`` facets
    /// layered in after the stage cut and before search + sort. Order:
    /// stage (cheapest) → facets → search → sort. The legacy `gradedOnly`
    /// overload above is kept for the existing call sites/tests; new code
    /// should fold `gradedOnly` into the criteria instead.
    ///
    /// - Parameters:
    ///   - soldDates: maps item id → linked sale date, so the sale-date facet
    ///     can window items the ``LocalInventoryItem`` row alone can't (the
    ///     sale lives in `LocalSale`). Empty = no sale-date filtering possible.
    ///   - serverSearchIds: optional set of item ids the server FTS
    ///     (`flipdesk_search`) matched. When present, an item passes the search
    ///     step if it matches the local token search *or* its id is in this set
    ///     — this is how iOS catches matches on fields the local cache doesn't
    ///     mirror (e.g. server-side `description`).
    ///   - photoItemIds: US-1520 — item ids with at least one cached photo,
    ///     precomputed by the caller in ONE `LocalItemPhoto` pass. When supplied,
    ///     the photo facet checks set membership instead of faulting every
    ///     item's lazy `photos` relationship (a main-thread stall applying the
    ///     facet on a large catalog). nil = fall back to the relationship.
    static func apply(
        _ items: [LocalInventoryItem],
        stage: InventoryStage,
        search: String,
        sort: SortOption,
        criteria: InventoryFilterCriteria,
        now: Date = .now,
        soldDates: [String: Date] = [:],
        serverSearchIds: Set<String>? = nil,
        photoItemIds: Set<String>? = nil
    ) -> [LocalInventoryItem] {
        let staged = items.filter { stage.matchingStatuses.contains($0.status) }
        let faceted = staged.filter {
            matches($0, criteria, now: now, soldDates: soldDates, photoItemIds: photoItemIds)
        }
        let searched = filter(faceted, search: search, serverSearchIds: serverSearchIds)
        return searched.sorted(by: sort.isOrdered)
    }

    /// Effective price used by both the price-band facet and the price
    /// facets bounds: most-specific known price wins (listed → target →
    /// acquired), matching the row's price-display fallback.
    static func effectivePrice(_ item: LocalInventoryItem) -> Double? {
        item.listingPrice ?? item.targetPrice ?? item.acquiredPrice
    }

    /// True when an item satisfies every active facet in `criteria`. An
    /// empty criteria matches everything. Multi-select facets are OR within
    /// a facet (any selected brand) and AND across facets (brand AND size).
    /// The advanced ``InventoryRuleQuery`` (its own AND/OR) is the final gate.
    static func matches(
        _ item: LocalInventoryItem,
        _ criteria: InventoryFilterCriteria,
        now: Date = .now,
        soldDates: [String: Date] = [:],
        photoItemIds: Set<String>? = nil
    ) -> Bool {
        if !criteria.brands.isEmpty {
            guard let b = item.brand?.facetTrimmed, criteria.brands.contains(b) else { return false }
        }
        if !criteria.sizes.isEmpty {
            guard let s = item.size?.facetTrimmed, criteria.sizes.contains(s) else { return false }
        }
        if !criteria.colors.isEmpty {
            guard let c = item.color?.facetTrimmed, criteria.colors.contains(c) else { return false }
        }
        if !criteria.locationBins.isEmpty {
            guard let l = item.locationBin?.facetTrimmed, criteria.locationBins.contains(l) else { return false }
        }
        if !criteria.sources.isEmpty {
            guard let src = item.sourceId?.facetTrimmed, criteria.sources.contains(src) else { return false }
        }
        if !criteria.categories.isEmpty {
            guard let cat = item.itemCategory?.facetTrimmed, criteria.categories.contains(cat) else { return false }
        }
        // US-3124: WHO bought it, matched on the name the item carries. An
        // item with nobody recorded matches no selection, the same way an
        // unbranded item matches no brand.
        if !criteria.sourcers.isEmpty {
            guard let who = item.sourcedBy?.facetTrimmed, criteria.sourcers.contains(who) else { return false }
        }

        if criteria.gradedOnly || criteria.minGrade != nil {
            guard let grade = item.gradeValue else { return false }
            if let floor = criteria.minGrade, grade < floor { return false }
        }

        // Price band (US-1247): an item with NO effective price is NOT silently
        // dropped whenever a bound is active. Explicit null-price semantics:
        //   • a `maxPrice`-only band KEEPS the unpriced item — an unpriced
        //     backlog item is "≤ any ceiling" and must stay reachable;
        //   • any active `minPrice` DROPS it — an unknown price can't be proven
        //     to clear a floor.
        if criteria.minPrice != nil || criteria.maxPrice != nil {
            if let price = effectivePrice(item) {
                if let lo = criteria.minPrice, price < lo { return false }
                if let hi = criteria.maxPrice, price > hi { return false }
            } else if criteria.minPrice != nil {
                return false
            }
        }

        switch criteria.photoState {
        // US-994: presence from the photo ROWS, not the primaryPhotoURL cache
        // (which drifts when the cover lags the actual photo set). US-1520:
        // prefer the caller's precomputed id set (one LocalItemPhoto pass) over
        // per-item relationship faulting.
        case .any:          break
        case .withPhoto:    if !itemHasPhotos(item, photoItemIds) { return false }
        case .missingPhoto: if itemHasPhotos(item, photoItemIds) { return false }
        }

        if let days = criteria.dateAdded.days {
            let cutoff = now.addingTimeInterval(-Double(days) * 86_400)
            if item.createdAt < cutoff { return false }
        }

        // US-1052: absolute purchase-date window over the acquisition proxy.
        if criteria.purchaseDates.isActive, !criteria.purchaseDates.contains(item.createdAt) {
            return false
        }
        // US-1052: sale-date window — only items with a known linked sale date
        // can clear an active filter (an unsold item can't be "sold last week").
        if criteria.saleDates.isActive {
            guard let sold = soldDates[item.id], criteria.saleDates.contains(sold) else { return false }
        }

        // US-1052: advanced AND/OR rule builder is the final gate.
        if !criteria.ruleQuery.matches(item, now: now) { return false }

        return true
    }

    /// US-1520: photo presence from the precomputed id set when supplied,
    /// falling back to the (per-item relationship-faulting) `hasPhotos` for
    /// callers/tests that don't provide one.
    private static func itemHasPhotos(
        _ item: LocalInventoryItem, _ photoItemIds: Set<String>?
    ) -> Bool {
        photoItemIds?.contains(item.id) ?? item.hasPhotos
    }

    /// Full-text-style search (US-1052). Tokenizes the query on whitespace /
    /// punctuation and requires *every* token to appear somewhere in the
    /// item's searchable text (title / brand / SKU / size / color / material /
    /// category / notes / location) — the AND-of-terms semantics of Postgres'
    /// `websearch_to_tsquery`, approximated locally. `serverSearchIds`, when
    /// supplied, lets a server-FTS hit (`flipdesk_search`) pass an item even if
    /// the local token match misses (e.g. the match was on a server-only field).
    static func filter(
        _ items: [LocalInventoryItem],
        search: String,
        serverSearchIds: Set<String>? = nil
    ) -> [LocalInventoryItem] {
        let tokens = searchTokens(search)
        guard !tokens.isEmpty else { return items }
        return items.filter { item in
            if let ids = serverSearchIds, ids.contains(item.id) { return true }
            let hay = searchableText(item)
            return tokens.allSatisfy { hay.contains($0) }
        }
    }

    /// Splits a query into lowercased alphanumeric tokens (drops punctuation
    /// and empties). Exposed `internal` so the list view can reuse identical
    /// tokenization when deciding whether to fire the server FTS.
    static func searchTokens(_ search: String) -> [String] {
        search
            .lowercased()
            .split { !$0.isLetter && !$0.isNumber }
            .map(String.init)
    }

    /// Concatenated, lowercased searchable text for one row. Mirrors the web
    /// FTS column set (title/brand/sku + description/notes) with the fields the
    /// local cache actually carries; server-only fields are covered by the
    /// `flipdesk_search` union in ``filter(_:search:serverSearchIds:)``.
    private static func searchableText(_ item: LocalInventoryItem) -> String {
        [
            item.title,
            item.brand,
            item.sku,
            item.size,
            item.color,
            item.material,
            item.itemCategory,
            // US-1248: these are mirrored on the local row and merged every sync,
            // so an offline/airplane-mode search by style or garment type must
            // match them too (previously they were silently unsearchable).
            item.style,
            item.garmentType,
            item.garmentCategory,
            item.conditionNotes,
            item.locationBin,
            item.container,
            item.sourcedBy,
        ]
        .compactMap { $0 }
        .joined(separator: " ")
        .lowercased()
    }
}
