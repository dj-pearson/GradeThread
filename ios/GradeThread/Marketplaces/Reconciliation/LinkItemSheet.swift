import SwiftData
import SwiftUI

/// Search sheet to link an unmatched eBay listing to an existing
/// inventory_items row. Pulls from the local SwiftData cache so search
/// is instant + works offline.
struct LinkItemSheet: View {
    @Environment(\.dismiss) private var dismiss

    let orphan: OrphanEbayListing
    let service: ReconciliationService
    let onComplete: (ReconciliationOutcome) -> Void

    @Query(sort: \LocalInventoryItem.updatedAt, order: .reverse)
    private var allItems: [LocalInventoryItem]

    @State private var query: String = ""
    @State private var isLinking = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                orphanHeader
                Divider()
                List {
                    if filtered.isEmpty {
                        emptyHint
                    } else {
                        ForEach(filtered) { item in
                            Button {
                                Task { await link(to: item.id) }
                            } label: {
                                row(for: item)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .listStyle(.plain)
                .searchable(text: $query, prompt: "Search title, brand, SKU")
            }
            .navigationTitle("Link to existing item")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isLinking)
                }
            }
            .overlay {
                if isLinking {
                    Color.black.opacity(0.15)
                        .ignoresSafeArea()
                    ProgressView().tint(.white)
                }
            }
            .alert(
                errorMessage ?? "",
                isPresented: Binding(
                    get: { errorMessage != nil },
                    set: { if !$0 { errorMessage = nil } }
                )
            ) {
                Button("OK") {}
            }
        }
    }

    // MARK: - Subviews

    private var orphanHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Linking eBay listing")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(orphan.displayTitle)
                .font(.subheadline.weight(.semibold))
                .lineLimit(2)
            if let sku = orphan.customLabel, !sku.isEmpty {
                Text("eBay SKU: \(sku)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color(uiColor: .secondarySystemGroupedBackground))
    }

    private func row(for item: LocalInventoryItem) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                HStack(spacing: 6) {
                    if let brand = item.brand {
                        Text(brand).font(.caption).foregroundStyle(.secondary)
                    }
                    if let sku = item.sku {
                        Text("SKU \(sku)").font(.caption).foregroundStyle(.secondary)
                    }
                    Text(item.status.capitalized).font(.caption2).foregroundStyle(.tertiary)
                }
            }
            Spacer()
            Image(systemName: "link")
                .foregroundStyle(Color.brandNavy)
        }
        .padding(.vertical, 6)
    }

    private var emptyHint: some View {
        HStack {
            Image(systemName: "magnifyingglass")
            Text(query.isEmpty
                ? "Type to search your inventory…"
                : "No items match '\(query)'.")
            Spacer()
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }

    // MARK: - Filtering + linking

    private var filtered: [LocalInventoryItem] {
        // Reuse InventoryFilter so the matching rules stay identical to
        // the inventory list's search.
        InventoryFilter.filter(allItems, search: query)
    }

    private func link(to itemId: String) async {
        guard !isLinking else { return }
        isLinking = true
        defer { isLinking = false }
        let outcome = await service.link(orphan: orphan, toExistingItemId: itemId)
        switch outcome.kind {
        case .linked:
            onComplete(outcome)
            dismiss()
        case .failed(let message):
            errorMessage = message
        case .created, .ignored:
            errorMessage = "Unexpected outcome."
        }
    }
}
