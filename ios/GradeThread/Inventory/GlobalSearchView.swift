import SwiftData
import SwiftUI

/// US-678 — global search across inventory, listings, sales, and sources from a
/// single field. Complements the web command-palette. Results are grouped by
/// entity type and deep-link to the relevant item canvas. Presented as a sheet
/// from a search affordance in the Home toolbar.
struct GlobalSearchView: View {
    @Environment(\.dismiss) private var dismiss

    @Query private var items: [LocalInventoryItem]
    @Query private var listings: [LocalListing]
    @Query private var sales: [LocalSale]
    @Query(sort: \LocalSource.name) private var sources: [LocalSource]

    @State private var query = ""
    @State private var debounced = ""
    // US-1517: the match set, computed ONCE per debounced query (and when the
    // cached tables grow mid-search) instead of live computed properties that
    // rebuilt itemsById inside filter closures and evaluated every matched*
    // list at least twice per body pass — a visible per-keystroke freeze on a
    // real catalog.
    @State private var results = GlobalSearchResults()
    // US-1053 — recent search suggestions offered when the field is empty.
    @State private var recentSearches = RecentSearchStore()

    var body: some View {
        NavigationStack {
            Group {
                if debounced.trimmingCharacters(in: .whitespaces).isEmpty {
                    if recentSearches.terms.isEmpty {
                        ContentUnavailableView(
                            "Search everything",
                            systemImage: "magnifyingglass",
                            description: Text("Find items, listings, sales, and sources by title, brand, SKU, buyer, or name.")
                        )
                    } else {
                        recentSearchesList
                    }
                } else if results.isEmpty {
                    ContentUnavailableView.search(text: debounced)
                } else {
                    resultsList
                }
            }
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: LocalInventoryItem.self) { item in
                ItemCanvasView(item: item)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Items, listings, sales, sources")
        .onSubmit(of: .search) {
            recentSearches.record(query)
        }
        .task(id: query) {
            try? await Task.sleep(nanoseconds: 200_000_000)
            guard !Task.isCancelled else { return }
            debounced = query
            results = computeResults(for: query)
        }
        // US-1517: a sync pull can land rows while a search is showing — the old
        // live computed properties reflected that automatically, so refresh the
        // stored results when a table grows/shrinks (count is a cheap proxy).
        .onChange(of: items.count + listings.count + sales.count + sources.count) { _, _ in
            results = computeResults(for: debounced)
        }
    }

    private func computeResults(for query: String) -> GlobalSearchResults {
        GlobalSearchResults.compute(
            query: query, items: items, listings: listings, sales: sales, sources: sources
        )
    }

    // MARK: - Recent searches

    private var recentSearchesList: some View {
        List {
            Section("Recent searches") {
                ForEach(recentSearches.terms, id: \.self) { term in
                    Button {
                        query = term
                        debounced = term
                        results = computeResults(for: term)
                        // US-1187: re-running an old search via the list should
                        // refresh its recency, like submitting from the field.
                        recentSearches.record(term)
                    } label: {
                        Label(term, systemImage: "clock.arrow.circlepath")
                            .foregroundStyle(.primary)
                    }
                }
            }
            Section {
                Button("Clear recent searches", role: .destructive) {
                    recentSearches.clear()
                }
            }
        }
        .listStyle(.plain)
    }

    // MARK: - Results

    private var resultsList: some View {
        List {
            if !results.items.isEmpty {
                Section("Inventory") {
                    ForEach(results.items) { item in
                        NavigationLink(value: item) {
                            row(title: item.title, subtitle: itemSubtitle(item), system: "shippingbox")
                        }
                    }
                }
            }
            if !results.listings.isEmpty {
                Section("Listings") {
                    ForEach(results.listings) { hit in
                        NavigationLink(value: hit.item) {
                            row(title: hit.item.title,
                                subtitle: "\(hit.listing.platform.capitalized) · \(hit.listing.listingStatus)",
                                system: "tag")
                        }
                    }
                }
            }
            if !results.sales.isEmpty {
                Section("Sales") {
                    ForEach(results.sales) { hit in
                        NavigationLink(value: hit.item) {
                            row(title: hit.item.title,
                                subtitle: hit.sale.buyerUsername.map { "Buyer \($0)" } ?? "Sold",
                                system: "dollarsign.circle")
                        }
                    }
                }
            }
            if !results.sources.isEmpty {
                Section("Sources") {
                    ForEach(results.sources) { source in
                        // US-1498: these rows looked identical to the tappable
                        // item/sale rows but had no action — a dead row. Navigate
                        // to the source's filtered inventory (matches the "no
                        // tappable-looking dead rows" rule).
                        NavigationLink {
                            InventoryListView(initialSourceId: source.id)
                        } label: {
                            row(title: source.name, subtitle: source.sourceType.capitalized, system: "bag")
                        }
                    }
                }
            }
        }
        .listStyle(.plain)
    }

    private func row(title: String, subtitle: String, system: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: system).foregroundStyle(Color.brandNavy).frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.medium)).lineLimit(1)
                Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }
    }

    private func itemSubtitle(_ item: LocalInventoryItem) -> String {
        let parts = [item.brand, item.size].compactMap { value -> String? in
            (value?.isEmpty == false) ? value : nil
        }
        return parts.isEmpty ? item.status.capitalized : parts.joined(separator: " · ")
    }
}

// MARK: - Matching (US-1517)

/// One computed result set per debounced query. Extracted from the view (where
/// each `matched*` was a computed property evaluated at least twice per body
/// pass, each rebuilding `itemsById` inside its filter closure) so the whole
/// match — including the single `itemsById` build — runs exactly once per
/// query change. Listing/sale hits carry their joined item, preserving the
/// US-1187 rule that a section only renders rows whose parent item is cached.
struct GlobalSearchResults {
    struct ListingHit: Identifiable {
        let listing: LocalListing
        let item: LocalInventoryItem
        var id: String { listing.id }
    }
    struct SaleHit: Identifiable {
        let sale: LocalSale
        let item: LocalInventoryItem
        var id: String { sale.id }
    }

    var items: [LocalInventoryItem] = []
    var listings: [ListingHit] = []
    var sales: [SaleHit] = []
    var sources: [LocalSource] = []

    var isEmpty: Bool {
        items.isEmpty && listings.isEmpty && sales.isEmpty && sources.isEmpty
    }

    static func compute(
        query: String,
        items: [LocalInventoryItem],
        listings: [LocalListing],
        sales: [LocalSale],
        sources: [LocalSource]
    ) -> GlobalSearchResults {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return GlobalSearchResults() }
        func matches(_ haystacks: [String?]) -> Bool {
            haystacks.contains { ($0 ?? "").lowercased().contains(needle) }
        }
        let itemsById = Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })

        var results = GlobalSearchResults()
        results.items = items
            .filter { matches([$0.title, $0.brand, $0.sku, $0.size, $0.color, $0.material]) }
            .prefix(20).map { $0 }
        results.listings = listings
            .compactMap { listing -> ListingHit? in
                guard let item = itemsById[listing.inventoryItemId],
                      matches([listing.platform, listing.listingStatus, item.title])
                else { return nil }
                return ListingHit(listing: listing, item: item)
            }
            .prefix(20).map { $0 }
        results.sales = sales
            .compactMap { sale -> SaleHit? in
                guard let item = itemsById[sale.inventoryItemId],
                      matches([sale.buyerUsername, item.title])
                else { return nil }
                return SaleHit(sale: sale, item: item)
            }
            .prefix(20).map { $0 }
        results.sources = sources
            .filter { matches([$0.name, $0.notes, $0.sourceType]) }
            .prefix(20).map { $0 }
        return results
    }
}
