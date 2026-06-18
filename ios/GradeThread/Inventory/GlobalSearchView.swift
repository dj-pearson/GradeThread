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
                } else if isEmptyResult {
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
        }
    }

    // MARK: - Recent searches

    private var recentSearchesList: some View {
        List {
            Section("Recent searches") {
                ForEach(recentSearches.terms, id: \.self) { term in
                    Button {
                        query = term
                        debounced = term
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
            if !matchedItems.isEmpty {
                Section("Inventory") {
                    ForEach(matchedItems) { item in
                        NavigationLink(value: item) {
                            row(title: item.title, subtitle: itemSubtitle(item), system: "shippingbox")
                        }
                    }
                }
            }
            if !matchedListings.isEmpty {
                Section("Listings") {
                    ForEach(matchedListings) { listing in
                        if let item = itemsById[listing.inventoryItemId] {
                            NavigationLink(value: item) {
                                row(title: item.title,
                                    subtitle: "\(listing.platform.capitalized) · \(listing.listingStatus)",
                                    system: "tag")
                            }
                        }
                    }
                }
            }
            if !matchedSales.isEmpty {
                Section("Sales") {
                    ForEach(matchedSales) { sale in
                        if let item = itemsById[sale.inventoryItemId] {
                            NavigationLink(value: item) {
                                row(title: item.title,
                                    subtitle: sale.buyerUsername.map { "Buyer \($0)" } ?? "Sold",
                                    system: "dollarsign.circle")
                            }
                        }
                    }
                }
            }
            if !matchedSources.isEmpty {
                Section("Sources") {
                    ForEach(matchedSources) { source in
                        row(title: source.name, subtitle: source.sourceType.capitalized, system: "bag")
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

    // MARK: - Matching

    private var itemsById: [String: LocalInventoryItem] {
        Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    }

    private func matches(_ haystacks: [String?]) -> Bool {
        let needle = debounced.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return false }
        return haystacks.contains { ($0 ?? "").lowercased().contains(needle) }
    }

    private var matchedItems: [LocalInventoryItem] {
        items.filter { matches([$0.title, $0.brand, $0.sku, $0.size, $0.color, $0.material]) }
            .prefix(20).map { $0 }
    }
    private var matchedListings: [LocalListing] {
        listings.filter { matches([$0.platform, $0.listingStatus, itemsById[$0.inventoryItemId]?.title]) }
            .prefix(20).map { $0 }
    }
    private var matchedSales: [LocalSale] {
        sales.filter { matches([$0.buyerUsername, itemsById[$0.inventoryItemId]?.title]) }
            .prefix(20).map { $0 }
    }
    private var matchedSources: [LocalSource] {
        sources.filter { matches([$0.name, $0.notes, $0.sourceType]) }
            .prefix(20).map { $0 }
    }

    private var isEmptyResult: Bool {
        matchedItems.isEmpty && matchedListings.isEmpty && matchedSales.isEmpty && matchedSources.isEmpty
    }

    private func itemSubtitle(_ item: LocalInventoryItem) -> String {
        let parts = [item.brand, item.size].compactMap { value -> String? in
            (value?.isEmpty == false) ? value : nil
        }
        return parts.isEmpty ? item.status.capitalized : parts.joined(separator: " · ")
    }
}
