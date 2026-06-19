import SwiftUI
import SwiftData

/// AutoLister drafts library (US-675): the durable home for every unpublished
/// AutoLister draft, with search + a route into bulk-edit. Mirrors the web
/// autolister-drafts page. US-964 adds multi-select + a "Publish N" action so a
/// batch can be finished from the phone without opening each draft.
struct DraftsLibraryView: View {
    @Environment(\.modelContext) private var modelContext
    @State private var store = DraftsLibraryStore()
    @State private var search = ""
    @State private var editMode: EditMode = .inactive
    // US-745: the drafted item whose cross-marketplace Listing Kit is presented.
    @State private var kitTarget: ListingKitTarget?
    private let currency = CurrencyFormatter()

    var body: some View {
        content
            .navigationTitle("AutoLister drafts")
            .navigationBarTitleDisplayMode(.inline)
            .environment(\.editMode, $editMode)
            .toolbar { toolbarContent }
            .safeAreaInset(edge: .bottom) { publishBar }
            .task { await store.load() }
            .refreshable { await store.load() }
            // US-745: present the cross-marketplace Listing Kit for a drafted item.
            .sheet(item: $kitTarget) { target in
                NavigationStack {
                    ListingKitView(itemId: target.id, itemTitle: target.title)
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) {
                                Button("Done") { kitTarget = nil }
                            }
                        }
                }
            }
            // US-964: published-vs-skipped summary, reusing the bulk-edit publish
            // result UI shape (a single alert over the summary string).
            .alert(
                "Publish to eBay",
                isPresented: Binding(
                    get: { store.publishSummary != nil },
                    set: { if !$0 { store.publishSummary = nil } }
                ),
                presenting: store.publishSummary
            ) { _ in
                Button("OK", role: .cancel) { store.publishSummary = nil }
            } message: { Text($0) }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            NavigationLink {
                DraftsBulkEditView()
            } label: {
                Label("Bulk edit", systemImage: "square.and.pencil")
            }
            .disabled(store.isEmpty || editMode == .active)
        }
        ToolbarItem(placement: .topBarTrailing) {
            if store.phase == .ready && !store.isEmpty {
                // EditButton drives `editMode`, flipping rows into multi-select.
                EditButton()
            }
        }
    }

    /// US-964: the bulk-publish action, shown only while selecting drafts.
    @ViewBuilder
    private var publishBar: some View {
        if editMode == .active && !store.selected.isEmpty {
            Button {
                Task {
                    let published = await store.publishSelected()
                    applyOptimisticPublish(listingIds: published)
                    if !published.isEmpty { editMode = .inactive }
                }
            } label: {
                HStack(spacing: 8) {
                    if store.isPublishing {
                        ProgressView().tint(.white)
                    } else {
                        Image(systemName: "paperplane.fill")
                    }
                    Text("Publish \(store.selected.count)")
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(Color.brandNavy)
                .foregroundStyle(.white)
                .clipShape(Capsule())
            }
            .disabled(store.isPublishing)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.bar)
        }
    }

    /// US-964: optimistically flip the published drafts' cached listing rows to
    /// `active` so the dashboards/active-count update before the next sync pull,
    /// then request a pull to reconcile with server truth (`SyncEngine.merge`
    /// treats marketplace fields as server-authoritative).
    private func applyOptimisticPublish(listingIds: Set<String>) {
        guard !listingIds.isEmpty else { return }
        let ids = Array(listingIds)
        let descriptor = FetchDescriptor<LocalListing>(
            predicate: #Predicate { ids.contains($0.id) }
        )
        if let rows = try? modelContext.fetch(descriptor) {
            let now = Date.now
            for row in rows {
                row.listingStatus = "active"
                row.listedAt = now
                row.updatedAt = now
            }
            try? modelContext.save()
        }
        NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
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
        // US-964: `List(selection:)` drives multi-select in edit mode; outside
        // edit mode rows stay tappable NavigationLinks into the per-batch editor.
        List(selection: Binding(
            get: { store.selected },
            set: { store.selected = $0 }
        )) {
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
                    // US-681: a row tap opens the bulk-edit (review + publish)
                    // scoped to this draft's batch, instead of being a dead row.
                    NavigationLink {
                        DraftsBulkEditView(batchId: draft.batchId)
                    } label: {
                        DraftLibraryRow(
                            title: store.title(for: draft),
                            draft: draft,
                            currency: currency
                        )
                    }
                    // US-745: cross-list this item to the no-API marketplaces via
                    // the copy/paste Listing Kit (Poshmark/Mercari/Grailed/Depop).
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button {
                            kitTarget = ListingKitTarget(
                                id: draft.inventoryItemId,
                                title: store.title(for: draft)
                            )
                        } label: {
                            Label("Listing Kit", systemImage: "doc.on.doc")
                        }
                        .tint(.brandNavy)
                    }
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

// US-745: identifies the drafted item whose Listing Kit sheet is presented.
private struct ListingKitTarget: Identifiable {
    let id: String   // inventory item id
    let title: String
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
