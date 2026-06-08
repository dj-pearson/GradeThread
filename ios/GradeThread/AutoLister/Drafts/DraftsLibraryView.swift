import SwiftUI

/// AutoLister drafts library (US-675): the durable home for every unpublished
/// AutoLister draft, with search + a route into bulk-edit. Mirrors the web
/// autolister-drafts page.
struct DraftsLibraryView: View {
    @State private var store = DraftsLibraryStore()
    @State private var search = ""
    private let currency = CurrencyFormatter()

    var body: some View {
        content
            .navigationTitle("AutoLister drafts")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        DraftsBulkEditView()
                    } label: {
                        Label("Bulk edit", systemImage: "square.and.pencil")
                    }
                    .disabled(store.isEmpty)
                }
            }
            .task { await store.load() }
            .refreshable { await store.load() }
    }

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .loading:
            ScrollView { SkeletonRows(count: 6) }

        case .failed(let message):
            ContentUnavailableView {
                Label("Couldn't load drafts", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") { Task { await store.load() } }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.brandNavy)
            }

        case .ready where store.isEmpty:
            ContentUnavailableView {
                Label("No unpublished drafts yet", systemImage: "square.stack.3d.up")
            } description: {
                Text("Generate listings in AutoLister and they'll wait here until you review and publish them.")
            }

        case .ready:
            list
        }
    }

    private var list: some View {
        List {
            Section {
                HStack {
                    Text("\(store.drafts.count) draft\(store.drafts.count == 1 ? "" : "s")")
                        .font(.subheadline.weight(.medium))
                    Spacer()
                    Text("\(currency.formatDisplay(store.totalValue)) list value")
                        .font(.subheadline)
                        .foregroundStyle(Color.brandNavy)
                }
                if store.batchCount > 0 {
                    Text("Across \(store.batchCount) batch\(store.batchCount == 1 ? "" : "es")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                ForEach(store.filtered(matching: search)) { draft in
                    DraftLibraryRow(
                        title: store.title(for: draft),
                        draft: draft,
                        currency: currency
                    )
                }
            } header: {
                Text("Drafts")
            } footer: {
                if !search.isEmpty && store.filtered(matching: search).isEmpty {
                    Text("No drafts match “\(search)”.")
                }
            }
        }
        .searchable(text: $search, prompt: "Search drafts by title")
    }
}

private struct DraftLibraryRow: View {
    let title: String
    let draft: DraftListing
    let currency: CurrencyFormatter

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .lineLimit(2)
            HStack(spacing: 6) {
                Text(currency.formatDisplay(draft.listingPrice))
                    .font(.caption.weight(.semibold))
                if draft.priceIsEstimated == true {
                    Text("est.")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Color.brandAmber.opacity(0.18))
                        .foregroundStyle(Color.brandAmber)
                        .clipShape(Capsule())
                }
                categoryBadge
                Spacer()
                Text(draft.created, format: .dateTime.month().day())
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var categoryBadge: some View {
        if let cat = draft.platformCategoryId, !cat.isEmpty {
            Text("cat \(cat)")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        } else {
            Text("needs category")
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .background(Color.brandAmber.opacity(0.18))
                .foregroundStyle(Color.brandAmber)
                .clipShape(Capsule())
        }
    }
}
