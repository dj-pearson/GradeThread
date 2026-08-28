import SwiftUI
import SwiftData

/// AutoLister drafts library (US-675): the durable home for every unpublished
/// AutoLister draft, with search + a route into bulk-edit. Mirrors the web
/// autolister-drafts page. US-964 adds multi-select + a "Publish N" action so a
/// batch can be finished from the phone without opening each draft.
struct DraftsLibraryView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(AuthStore.self) private var authStore
    @State private var store = DraftsLibraryStore()
    // US-820: templates for the "Apply template" bulk action.
    @State private var templateStore = TemplateStore()
    @State private var search = ""
    @State private var editMode: EditMode = .inactive
    // US-745: the drafted item whose cross-marketplace Listing Kit is presented.
    /// US-2925: ONE sheet slot. The Listing Kit and the paywall were two
    /// chained `.sheet` modifiers, which is undefined in SwiftUI: they compete
    /// for the view's single slot and the loser opens and closes in the same
    /// frame. Reaching the paywall from this screen was the second one.
    private enum DraftsSheet: Identifiable {
        case listingKit(ListingKitTarget)
        case paywall

        var id: String {
            switch self {
            case .listingKit(let t): return "kit-\(t.id)"
            case .paywall: return "paywall"
            }
        }
    }
    @State private var draftsSheet: DraftsSheet?
    // US-820: bulk price-entry alert (absolute set or +/- %) + paywall route.
    @State private var priceKind: BulkPriceKind?
    @State private var priceText = ""
    // US-1160: bulk publish pushes drafts live on eBay (irreversible) — confirm first.
    @State private var showPublishConfirm = false
    // US-1162: invalid bulk-price input message (system alert can't show inline).
    @State private var priceEntryError: String?
    /// The batch a row's leading swipe asked to bulk-edit. A swipe action can't
    /// hold a NavigationLink, so it sets this and the destination below pushes.
    @State private var swipedBatchId: String?
    private let currency = CurrencyFormatter()

    /// Which bulk price prompt is showing (drives one shared `.alert`).
    private enum BulkPriceKind: Identifiable, Equatable { case absolute, percent; var id: Self { self } }

    /// Signed-in user id for the paywall (nil in previews / signed-out).
    private var currentUserId: UUID? {
        if case let .signedIn(user) = authStore.phase { return user.id }
        return nil
    }

    var body: some View {
        content
            .navigationTitle("AutoLister drafts")
            .navigationBarTitleDisplayMode(.inline)
            .environment(\.editMode, $editMode)
            .toolbar { toolbarContent }
            .safeAreaInset(edge: .bottom) { bulkActionBar }
            .task {
                await store.load()
                await templateStore.load()
            }
            .refreshable { await store.load() }
            // The row's leading swipe still reaches the batch editor it used to
            // BE. See the note on the row's NavigationLink.
            .navigationDestination(item: $swipedBatchId) { batchId in
                DraftsBulkEditView(batchId: batchId.isEmpty ? nil : batchId)
            }
            // US-745: present the cross-marketplace Listing Kit for a drafted item.
            .sheet(item: $draftsSheet) { sheet in
                switch sheet {
                case .paywall:
                    if let userId = currentUserId {
                        NavigationStack { PaywallView(userId: userId) }
                    }
                case .listingKit(let target):
                    NavigationStack {
                        ListingKitView(itemId: target.id, itemTitle: target.title)
                            .toolbar {
                                ToolbarItem(placement: .confirmationAction) {
                                    Button("Done") { draftsSheet = nil }
                                }
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
            // US-820: bulk field-apply result (per-item failures included).
            .alert(
                "Bulk update",
                isPresented: Binding(
                    get: { store.bulkSummary != nil },
                    set: { if !$0 { store.bulkSummary = nil } }
                ),
                presenting: store.bulkSummary
            ) { _ in
                Button("OK", role: .cancel) { store.bulkSummary = nil }
            } message: { Text($0) }
            // US-820 / US-805: a bulk publish that hit a plan cap routes here with
            // an Upgrade affordance instead of a generic failure.
            .alert(
                "Plan limit reached",
                isPresented: Binding(
                    get: { store.planLimitMessage != nil },
                    set: { if !$0 { store.planLimitMessage = nil } }
                ),
                presenting: store.planLimitMessage
            ) { _ in
                if currentUserId != nil {
                    Button("Upgrade") { draftsSheet = .paywall }
                }
                Button("OK", role: .cancel) { store.planLimitMessage = nil }
            } message: { Text($0) }
            // US-820: shared price-entry prompt (absolute set or +/- %).
            .alert(
                priceKind == .percent ? "Adjust price by %" : "Set price",
                isPresented: Binding(
                    get: { priceKind != nil },
                    set: { if !$0 { priceKind = nil; priceText = "" } }
                ),
                presenting: priceKind
            ) { kind in
                TextField(kind == .percent ? "e.g. -10 or 15" : "0.00", text: $priceText)
                    .keyboardType(kind == .percent ? .numbersAndPunctuation : .decimalPad)
                Button("Cancel", role: .cancel) { priceKind = nil; priceText = "" }
                Button("Apply") { applyPriceEntry(kind) }
            } message: { kind in
                Text(kind == .percent
                     ? "Positive marks up, negative marks down. Applies to \(store.selected.count) selected."
                     : "Applies to \(store.selected.count) selected draft\(store.selected.count == 1 ? "" : "s").")
            }
            // US-1162: invalid price-entry feedback (the entry alert can't show it inline).
            .alert(
                "Invalid amount",
                isPresented: Binding(
                    get: { priceEntryError != nil }, set: { if !$0 { priceEntryError = nil } }
                )
            ) {
                Button("OK", role: .cancel) { priceEntryError = nil }
            } message: {
                Text(priceEntryError ?? "")
            }
    }

    /// Parses the price-entry text and runs the matching bulk price edit.
    private func applyPriceEntry(_ kind: BulkPriceKind) {
        let text = priceText.trimmingCharacters(in: .whitespaces)
        // US-1162: locale-aware parse, and surface a message instead of a silent
        // no-op when the input can't be read.
        guard let value = CurrencyFormatter().parse(text) else {
            priceEntryError = kind == .percent
                ? "Enter a percentage like -10 or 15."
                : "Enter an amount like 19.99."
            return
        }
        Task {
            switch kind {
            case .absolute: await store.applyBulk(.price(.absolute(value)))
            case .percent:  await store.applyBulk(.price(.percent(value)))
            }
        }
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
        // US-1897 (AC5): sort by Listing Quality Score, worst first — the
        // triage order the score exists to enable. Hidden while multi-selecting
        // so reordering can't shuffle rows out from under a selection.
        ToolbarItem(placement: .topBarTrailing) {
            if store.phase == .ready && !store.isEmpty && editMode != .active {
                Menu {
                    Picker("Sort", selection: Binding(
                        get: { store.sortOrder },
                        set: { store.sortOrder = $0 }
                    )) {
                        ForEach(DraftsLibraryStore.SortOrder.allCases) { order in
                            Text(order.label).tag(order)
                        }
                    }
                } label: {
                    Label("Sort", systemImage: "arrow.up.arrow.down")
                }
            }
        }
    }

    /// US-820: the multi-select bulk action bar (matches the Inventory
    /// multi-select pattern) — a bulk-edit menu (price / condition / template)
    /// plus the US-964 bulk-publish action. Shown only while selecting drafts.
    @ViewBuilder
    private var bulkActionBar: some View {
        if editMode == .active && !store.selected.isEmpty {
            HStack(spacing: 12) {
                editMenu
                Spacer(minLength: 8)
                publishButton
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.bar)
            .overlay(alignment: .top) { applyingProgress }
        }
    }

    /// Bulk field-apply menu: price (absolute / %, round-to-.99), condition, and
    /// "apply template" — each writes through the drafts service per draft.
    private var editMenu: some View {
        Menu {
            Section("Price") {
                Button { priceKind = .absolute } label: { Label("Set price…", systemImage: "dollarsign.circle") }
                Button { priceKind = .percent } label: { Label("Adjust by %…", systemImage: "percent") }
                Button { Task { await store.applyBulk(.price(.round99)) } } label: {
                    Label("Round to .99", systemImage: "tag")
                }
            }
            Menu {
                ForEach(EbayCondition.allCases) { c in
                    Button(c.label) { Task { await store.applyBulk(.condition(c.rawValue)) } }
                }
            } label: {
                Label("Set condition", systemImage: "checkmark.seal")
            }
            if !templateStore.templates.isEmpty {
                Menu {
                    ForEach(templateStore.templates) { t in
                        Button(t.name) { Task { await store.applyBulk(.template(t)) } }
                    }
                } label: {
                    Label("Apply template", systemImage: "doc.on.doc")
                }
            }
        } label: {
            if store.isApplying {
                ProgressView()
            } else {
                Label("Edit \(store.selected.count)", systemImage: "slider.horizontal.3")
                    .fontWeight(.semibold)
            }
        }
        .disabled(store.isApplying || store.isPublishing)
    }

    private var publishButton: some View {
        Button {
            showPublishConfirm = true
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
            .padding(.horizontal, 18)
            .padding(.vertical, 12)
            .background(Color.brandNavy)
            .foregroundStyle(.white)
            .clipShape(Capsule())
        }
        .disabled(store.isPublishing || store.isApplying)
        .confirmationDialog(
            "Publish \(store.selected.count) draft\(store.selected.count == 1 ? "" : "s")?",
            isPresented: $showPublishConfirm,
            titleVisibility: .visible
        ) {
            Button("Publish \(store.selected.count) live", role: .destructive) {
                Task {
                    let published = await store.publishSelected()
                    applyOptimisticPublish(listingIds: published)
                    if !published.isEmpty { editMode = .inactive }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This lists the selected draft\(store.selected.count == 1 ? "" : "s") live on eBay.")
        }
    }

    /// Transient "Updating n/N…" pill above the bar during a bulk field-apply.
    @ViewBuilder
    private var applyingProgress: some View {
        if let p = store.bulkProgress {
            Text("Updating \(p.done)/\(p.total)…")
                .font(.caption.weight(.medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(.bar, in: Capsule())
                .offset(y: -30)
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
            modelContext.saveOrLog("applyOptimisticPublish")
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
                if store.hitFetchCap {
                    // US-1166: the fetch caps at 500 rows; tell the user some older
                    // drafts may not be shown rather than silently dropping them.
                    Label("Showing your most recent drafts — older ones may not appear.",
                          systemImage: "info.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                ForEach(store.filtered(matching: search)) { draft in
                    // A row tap opens THE ROW'S OWN ITEM.
                    //
                    // US-681 pushed `DraftsBulkEditView(batchId:)` here, and its
                    // comment said that was "instead of being a dead row":
                    // true at the time, and the wrong destination once AutoLister
                    // started landing twenty drafts in a batch. Tapping one
                    // listing opened a grid of every listing beside it, where the
                    // one the seller pointed at is just another row. Worse, that
                    // grid edits title, price, condition and category only, so a
                    // tap aimed at photos, measurements, specifics or the
                    // description arrived somewhere that cannot edit any of them.
                    //
                    // The batch editor is not lost: the toolbar opens it across
                    // every draft, and this row's leading swipe opens it scoped
                    // to this batch, which is the US-681 destination exactly.
                    NavigationLink {
                        DraftItemDestination(
                            inventoryItemId: draft.inventoryItemId,
                            batchId: draft.batchId,
                            title: store.title(for: draft)
                        )
                    } label: {
                        DraftLibraryRow(
                            title: store.title(for: draft),
                            draft: draft,
                            currency: currency
                        )
                    }
                    .swipeActions(edge: .leading, allowsFullSwipe: false) {
                        Button {
                            // Empty string means "this draft has no batch", which
                            // the destination maps back to nil (all drafts).
                            swipedBatchId = draft.batchId ?? ""
                        } label: {
                            Label("Bulk edit batch", systemImage: "square.grid.2x2")
                        }
                        .tint(Color.brandNavy)
                    }
                    // US-745: cross-list this item to the no-API marketplaces via
                    // the copy/paste Listing Kit (Poshmark/Mercari/Grailed/Depop).
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button {
                            draftsSheet = .listingKit(ListingKitTarget(
                                id: draft.inventoryItemId,
                                title: store.title(for: draft)
                            ))
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

/// Resolves a draft row's `inventory_item_id` to the cached `LocalInventoryItem`
/// the item canvas needs, and shows the canvas.
///
/// ``ItemCanvasView`` takes the SwiftData model, not an id, because it builds
/// four `@Query` filters off it in `init`. A drafts row only carries the id, so
/// something has to bridge the two, and that bridge has to answer the case
/// where the row is not cached yet.
///
/// It IS reachable. AutoLister creates items server-side and posts no
/// `.inventoryPullRequested`, so a seller who walks straight from a finished
/// AutoLister run into Drafts can be looking at a draft whose item has not
/// arrived in the local store. Rather than a dead push, this asks for a pull and
/// waits: `@Query` is live, so the canvas appears by itself the moment the merge
/// lands. The batch editor stays reachable in the meantime, because it reads the
/// drafts from the server and does not need the cache at all.
private struct DraftItemDestination: View {
    let inventoryItemId: String
    let batchId: String?
    let title: String

    @Query private var rows: [LocalInventoryItem]
    /// Ask for the pull once per appearance, not once per re-render.
    @State private var requestedPull = false

    init(inventoryItemId: String, batchId: String?, title: String) {
        self.inventoryItemId = inventoryItemId
        self.batchId = batchId
        self.title = title
        // Same shape as ``ItemCanvasView``'s own `itemRows` query: filter at
        // @Query time on the captured id so SwiftData re-runs it as the store
        // updates, which is what makes the sync-and-wait above work.
        let id = inventoryItemId
        _rows = Query(filter: #Predicate<LocalInventoryItem> { $0.id == id })
    }

    var body: some View {
        if let item = rows.first {
            ItemCanvasView(item: item)
        } else {
            ContentUnavailableView {
                Label("Still syncing this item", systemImage: "arrow.triangle.2.circlepath")
            } description: {
                Text("\(title) was just created and hasn't reached this device yet. This page opens on its own when it arrives.")
            } actions: {
                NavigationLink {
                    DraftsBulkEditView(batchId: batchId)
                } label: {
                    Text("Edit the batch instead")
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.brandNavy)
            }
            .task {
                guard !requestedPull else { return }
                requestedPull = true
                NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
            }
        }
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
                // US-1897 (AC5): the persisted score, straight from the column.
                // Nothing is recomputed here — the same number the composer
                // shows and the sort uses.
                QualityScoreChip(summary: draft.quality)
                Spacer()
                Text(draft.created, format: .dateTime.month().day())
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if let publishError = draft.publishError, !publishError.isEmpty {
                // US-1511: a scheduled/AutoLister publish failed and the draft
                // landed back here carrying the mapped reason — surface it so the
                // failure isn't invisible on iOS (web has shown this since US-321).
                Label(publishError, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption2)
                    .foregroundStyle(Color.brandRed)
                    .lineLimit(2)
                    .accessibilityLabel("Last publish failed: \(publishError)")
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
