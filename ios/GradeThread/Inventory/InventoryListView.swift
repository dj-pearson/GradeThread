import SwiftData
import SwiftUI
import UIKit

/// Main inventory triage screen. Mirrors the web `listings.tsx` tabbed
/// layout but optimized for one-handed iPhone use — TabView at the
/// bottom of the screen, search bar above, pull-to-refresh, sort menu.
///
/// Items are fetched once via @Query against the SwiftData cache and
/// then filtered/sorted in-memory per the active stage + search + sort.
/// Pull-to-refresh fires SyncEngine.pull() which re-populates the cache;
/// SwiftData's reactive @Query refreshes the list automatically.
struct InventoryListView: View {
    @Environment(\.photoUploadService) private var photoUploadService
    @Environment(AuthStore.self) private var authStore

    @Query(sort: \LocalInventoryItem.updatedAt, order: .reverse)
    private var allItems: [LocalInventoryItem]

    /// US-1052: source rows feed the source facet's id→name resolution.
    @Query private var sources: [LocalSource]
    /// US-1052: sales rows feed the sale-date facet (the sold date lives on the
    /// sale, not the item).
    @Query private var sales: [LocalSale]

    @Environment(\.syncEngine) private var syncEngine
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var selectedStage: InventoryStage = .all
    /// The Unlisted tab's chip (All / Needs draft / Drafted). Kept when the
    /// seller switches tabs, so coming back to Unlisted finds it as left.
    @State private var unlistedFilter: InventoryStage.UnlistedFilter = .all
    /// US-813: list vs. kanban-board layout. The board ignores the stage tabs
    /// (it shows every pipeline column) but still honors search + filters.
    @State private var viewMode: InventoryViewMode = .list
    @State private var searchQuery: String = ""
    /// Debounced mirror of `searchQuery` (US-639) — the filter re-runs against
    /// this, not on every keystroke, so typing on a large inventory stays
    /// responsive.
    @State private var debouncedQuery: String = ""
    /// Transient pull-to-refresh failure message (US-643).
    @State private var refreshError: String?
    @State private var sortOption: SortOption = .newest
    /// Advanced multi-facet filter (brand / size / color / price / grade /
    /// photo / recency). The old single "graded only" toggle is folded in
    /// as `criteria.gradedOnly`.
    @State private var criteria = InventoryFilterCriteria()

    /// US-1064: community-insights recommendations deep-link here pre-filtered to
    /// a single brand. US-814: the Sources manager deep-links here pre-filtered to
    /// a single acquisition source. Default (`nil`) keeps the unfiltered list
    /// every other call site expects.
    init(initialBrand: String? = nil, initialSourceId: String? = nil) {
        var seeded = InventoryFilterCriteria()
        if let brand = initialBrand, !brand.isEmpty {
            seeded.brands = [brand]
        }
        if let sourceId = initialSourceId, !sourceId.isEmpty {
            seeded.sources = [sourceId]
        }
        if seeded.isActive {
            _criteria = State(initialValue: seeded)
        }
    }
    /// Which of the list's three sheets is up. One optional driving ONE
    /// `.sheet(item:)` — a view has a single sheet slot, and three chained
    /// `.sheet(isPresented:)` modifiers compete for it (see ``ToolModule``).
    @State private var sheet: InventorySheet?

    /// The sheets the inventory list can present.
    private enum InventorySheet: Identifiable {
        /// The advanced-filter editor.
        case filter
        /// US-184: the eBay sync modal, which owns a poll task.
        case sync
        /// Bulk certified grading, not the confirmation-dialog path.
        case bulkGrade
        /// US-644: per-item failure detail for the last bulk action.
        case failures
        /// US-685: publish a single row to eBay without entering the canvas.
        case publish(LocalInventoryItem)
        /// US-685: quick price edit from the row.
        case priceEdit(LocalInventoryItem)

        var id: String {
            switch self {
            case .filter:              return "filter"
            case .sync:                return "sync"
            case .bulkGrade:           return "bulkGrade"
            case .failures:            return "failures"
            case .publish(let item):   return "publish-\(item.id)"
            case .priceEdit(let item): return "priceEdit-\(item.id)"
            }
        }
    }
    /// US-1017: memoizes the filtered list, per-stage counts, and facet index so
    /// an unrelated `@State` change (a sheet toggle, select mode, the refresh
    /// banner) doesn't re-run a full filter+sort / count / facet pass on the
    /// main thread. A plain reference type, so mutating its cache during `body`
    /// doesn't invalidate the view.
    @State private var derivation = InventoryDerivation()
    @State private var savedFilters = SavedFilterStore()
    /// US-1052: server-side full-text search (`flipdesk_search`), unioned with
    /// the local token search so matches on server-only fields still surface.
    @State private var searchService = InventorySearchService()

    // US-182 multi-select
    @State private var selection = BulkSelectionStore()
    @State private var pendingAction: BulkAction?
    @State private var actionResult: BulkActionResult?
    private let executor = BulkActionExecutor()

    // US-642 swipe-delete confirmation
    @State private var pendingSwipeDelete: LocalInventoryItem?
    // US-644 progress + per-item failures + undo
    @State private var actionProgress: (done: Int, total: Int)?
    @State private var undoContext: BulkUndoContext?

    @State private var bulkGradeTargetIds: [String] = []

    // US-184 sync
    @State private var syncStore = EbaySyncStore()
    // US-1007: retained so dismissing the modal cancels the poll loop promptly.
    @State private var syncTask: Task<Void, Never>?
    @Environment(\.modelContext) private var modelContext

    // US-193 drag-drop from Photos.app — captures live here until the
    // PhotoIntakeView mounts and seeds its own store from them.
    @State private var droppedCaptures: [CaptureSlot: PhotoCapture] = [:]
    @State private var showingDroppedIntake = false

    // US-685: per-row quick actions — publish to eBay + quick price edit
    // without pushing the full canvas.

    /// Statuses where listing to eBay makes sense (pre-list pipeline stages).
    private static let publishableStatuses: Set<String> = [
        "photographed", "graded", "comped", "drafted", "measured", "cataloged", "sourced",
    ]

    var body: some View {
        VStack(spacing: 0) {
            // The board shows every pipeline column at once, so the per-stage tab
            // bar would only confuse it — hide it in board mode.
            if viewMode == .list {
                tabRow
                if selectedStage == .unlisted {
                    unlistedChipRow
                }
            }
            ActiveFilterBar(criteria: $criteria, sourceNames: sourceNames)
            if viewMode == .board {
                board
            } else {
                list
            }
        }
        .navigationTitle("Inventory")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            viewModeToolbarItem
            sortToolbarItem
            filterToolbarItem
            selectToolbarItem
            syncToolbarItem
        }
        .sheet(item: $sheet) { presented in
            switch presented {
            case .filter:
                InventoryFilterSheet(
                    criteria: $criteria,
                    facets: facets,
                    savedFilters: savedFilters,
                    resultCount: { resultCount(for: $0) }
                )
            case .sync:
                // US-1007: the poll loop is cancelled on the way out. Scoped to
                // this case rather than a shared onDismiss, so closing the filter
                // never resets the sync store, and hung on onDisappear so a
                // swipe-to-dismiss (which never calls the modal's own callback)
                // cancels it too. cancelSync() is idempotent.
                EbaySyncModal(store: syncStore, onDismiss: { cancelSync() })
                    .onDisappear { cancelSync() }
            case .bulkGrade:
                BulkGradeSheet(itemIds: bulkGradeTargetIds) {
                    // Clear selection + exit edit mode, then pull so the new
                    // grades land on each row.
                    if selection.isEditing { selection.toggleEditing() }
                    NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
                }
            case .failures:
                if let result = actionResult {
                    BulkFailuresView(
                        result: result,
                        items: allItems,
                        // US-756: retry only the failed set (dismisses the sheet
                        // via retryFailed); omitted for non-retryable actions.
                        onRetry: Self.isRetryable(result.action)
                            ? { Task { await retryFailed(result) } }
                            : nil
                    )
                }
            case .publish(let item):
                PublishDialog(inventoryItemId: item.id, acquiredCost: item.acquiredPrice) { _ in
                    NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
                }
            case .priceEdit(let item):
                QuickPriceSheet(item: item)
                    .presentationDetents([.height(220)])
            }
        }
        .fullScreenCover(isPresented: $showingDroppedIntake, onDismiss: {
            droppedCaptures.removeAll()
        }) {
            PhotoIntakeView(initialPhotos: droppedCaptures)
        }
        .searchable(
            text: $searchQuery,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Search title, brand, SKU"
        )
        .environment(\.editMode, .constant(selection.isEditing ? .active : .inactive))
        .safeAreaInset(edge: .bottom) {
            if selection.isEditing, selection.count > 0 {
                BulkActionBar(
                    stage: selectedStage,
                    selectedCount: selection.count,
                    onAction: { action in
                        if action == .grade {
                            // Grading has its own readiness + tier + credits
                            // sheet rather than the simple confirm dialog.
                            bulkGradeTargetIds = Array(selection.selected)
                            sheet = .bulkGrade
                        } else {
                            pendingAction = action
                        }
                    },
                    onCancel: { selection.toggleEditing() }
                )
            }
        }
        .confirmationDialog(
            pendingAction?.confirmationTitle(count: selection.count) ?? "",
            isPresented: Binding(
                get: { pendingAction != nil },
                set: { if !$0 { pendingAction = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let action = pendingAction {
                Button(
                    action.label,
                    role: action.isDestructive ? .destructive : nil
                ) {
                    Task { await runAction(action) }
                }
            }
            Button("Cancel", role: .cancel) {}
        }
        .alert(
            actionResult?.summary ?? "",
            isPresented: Binding(
                get: { actionResult != nil },
                set: { if !$0 { actionResult = nil } }
            )
        ) {
            // US-644: when some items failed, offer to see the per-item reasons
            // the executor already built — not just the summary count.
            // US-756: and a one-tap "Retry N failed" that re-runs ONLY the
            // failed set, so the user never re-selects + re-runs the whole batch.
            if let result = actionResult, !result.failures.isEmpty {
                if Self.isRetryable(result.action) {
                    Button("Retry \(result.failures.count) failed") {
                        // Capture the result now — dismissing this alert nils
                        // `actionResult`, so the async retry can't read it back.
                        Task { await retryFailed(result) }
                    }
                }
                Button("View details") { sheet = .failures }
            }
            Button("OK") {}
        }
        // US-642: confirm destructive single-item delete.
        .alert(
            "Delete item?",
            isPresented: Binding(
                get: { pendingSwipeDelete != nil },
                set: { if !$0 { pendingSwipeDelete = nil } }
            ),
            presenting: pendingSwipeDelete
        ) { item in
            Button("Delete", role: .destructive) {
                Task { await deleteItem(item) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { item in
            Text("\(item.title) will be removed. This can't be undone.")
        }
        // US-644: progress HUD for longer multi-item batches.
        .overlay {
            if let progress = actionProgress, progress.total > 1 {
                BulkProgressHUD(done: progress.done, total: progress.total)
            }
        }
        // US-644: undo snackbar. US-972: it now shows a live countdown and
        // auto-dismisses itself when the window closes, so the undo window is
        // never a silently-vanishing affordance.
        .overlay(alignment: .bottom) {
            if let undo = undoContext {
                BulkUndoBar(context: undo) {
                    withAnimation(ReducedMotion.animation(.default)) { undoContext = nil }
                }
                .padding(.bottom, selection.isEditing ? 80 : 24)
            }
        }
        .refreshable {
            // Triggered by the user pulling the list down. SyncEngine
            // pulls fresh rows from Supabase and merges; the local
            // @Query re-renders when SwiftData notifies.
            await refreshFromServer()
        }
        // US-639: debounce the live search binding before it reaches the
        // filter. `.task(id:)` cancels the prior wait on each keystroke.
        .task(id: searchQuery) {
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
            debouncedQuery = searchQuery
        }
        // US-1052: run the server-side FTS for the debounced term. Best-effort
        // and additive — its result ids are unioned with the local search; an
        // empty/short term clears it so we fall back to pure local matching.
        .task(id: debouncedQuery) {
            let trimmed = debouncedQuery.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                searchService.clear()
            } else {
                await searchService.search(trimmed)
            }
        }
        // US-643 / US-1021: pull-to-refresh failure banner. Now offers Retry +
        // an explicit dismiss, and persists until dismissed while VoiceOver is
        // running (instead of auto-dismissing after 3.5s) so assistive-tech
        // users don't lose the announcement or the actionable controls.
        .overlay(alignment: .bottom) {
            if let refreshError {
                RefreshErrorBanner(
                    message: refreshError,
                    onRetry: {
                        withAnimation(ReducedMotion.animation(.default)) { self.refreshError = nil }
                        Task { await refreshFromServer() }
                    },
                    onDismiss: { withAnimation(ReducedMotion.animation(.default)) { self.refreshError = nil } }
                )
                .padding(.bottom, 24)
                .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
                .task(id: refreshError) {
                    // Auto-dismiss only when VoiceOver is OFF. With VoiceOver on
                    // the banner stays put until the user retries or dismisses.
                    guard !UIAccessibility.isVoiceOverRunning else { return }
                    try? await Task.sleep(nanoseconds: 3_500_000_000)
                    withAnimation(ReducedMotion.animation(.default)) { self.refreshError = nil }
                }
            }
        }
    }

    // MARK: - Layout

    private var tabRow: some View {
        // US-639: compute every stage's count in a single pass over the items
        // here, then look up per chip — instead of one full `.filter` pass per
        // visible chip on every render.
        let counts = stageCounts
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(InventoryStage.userFacing) { stage in
                    Button {
                        AppRouter.haptic()
                        selectedStage = stage
                    } label: {
                        tabChip(for: stage, count: counts[stage] ?? 0)
                    }
                    .buttonStyle(.plain)
                    // US-706: guarantee a 44pt touch target even though the
                    // visual chip is shorter.
                    .frame(minHeight: 44)
                    .contentShape(Capsule())
                    // US-702: selection must not be conveyed by colour alone.
                    .accessibilityLabel("\(stage.label), \(counts[stage] ?? 0) items")
                    .accessibilityAddTraits(selectedStage == stage ? .isSelected : [])
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .background(Color(uiColor: .systemBackground))
    }

    /// The split the old To List and Drafts tabs made, as chips inside
    /// Unlisted. Same touch-target and selection-trait rules as the tab row.
    private var unlistedChipRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(InventoryStage.UnlistedFilter.allCases) { filter in
                    let isSelected = unlistedFilter == filter
                    Button {
                        AppRouter.haptic()
                        unlistedFilter = filter
                    } label: {
                        Text(filter.label)
                            .font(.caption.weight(isSelected ? .semibold : .regular))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(
                                isSelected
                                    ? Color.accentColor.opacity(0.15)
                                    : Color(uiColor: .secondarySystemBackground)
                            )
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .frame(minHeight: 44)
                    .contentShape(Capsule())
                    .accessibilityLabel(filter.label)
                    .accessibilityAddTraits(isSelected ? .isSelected : [])
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
        }
        .background(Color(uiColor: .systemBackground))
    }

    private func tabChip(for stage: InventoryStage, count: Int) -> some View {
        let isSelected = selectedStage == stage
        return HStack(spacing: 6) {
            Image(systemName: stage.systemImage)
                .font(.caption.weight(.semibold))
            Text(stage.label)
                .font(.subheadline.weight(isSelected ? .semibold : .regular))
            Text("\(count)")
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .background(.white.opacity(isSelected ? 0.25 : 0))
                .background(.secondary.opacity(isSelected ? 0 : 0.12))
                .clipShape(Capsule())
        }
        .foregroundStyle(isSelected ? .white : .primary)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(isSelected ? Color.brandNavy : Color(uiColor: .secondarySystemBackground))
        .clipShape(Capsule())
    }

    @ViewBuilder
    private var list: some View {
        let filtered = filteredItems
        if filtered.isEmpty {
            emptyState
        } else {
            // List(selection:) renders the iOS-native checkbox column
            // when editMode == .active; in non-edit mode the binding is
            // ignored and tapping a row pushes the canvas via the
            // NavigationLink as before.
            //
            // Value-based NavigationLink (US-193): pushes the
            // LocalInventoryItem onto whichever stack is hosting us. In
            // compact mode that's the per-tab NavigationStack from
            // TabBarShell; in iPad three-column it's the detail
            // column's NavigationStack — SwiftUI routes the push to
            // the right place automatically.
            List(filtered, selection: $selection.selected) { item in
                NavigationLink(value: item) {
                    InventoryRow(item: item)
                }
                .tag(item.id)
                // US-642: per-item swipe actions, stage-appropriate.
                .swipeActions(edge: .leading, allowsFullSwipe: false) {
                    if item.status == "sold" {
                        Button {
                            Task { await perform(.markShipped, items: [item], isBulk: false) }
                        } label: {
                            Label("Shipped", systemImage: "shippingbox.fill")
                        }
                        .tint(Color.brandEmerald)
                    }
                    // US-685: list a ready item to eBay straight from the row.
                    if Self.publishableStatuses.contains(item.status) {
                        Button {
                            HapticFeedback.light()
                            sheet = .publish(item)
                        } label: {
                            Label("Publish", systemImage: "paperplane.fill")
                        }
                        .tint(Color.brandNavy)
                    }
                }
                // US-685: quick actions without pushing the canvas.
                .contextMenu {
                    if Self.publishableStatuses.contains(item.status) {
                        Button {
                            sheet = .publish(item)
                        } label: {
                            Label("Publish to eBay", systemImage: "paperplane")
                        }
                    }
                    Button {
                        sheet = .priceEdit(item)
                    } label: {
                        Label("Edit price", systemImage: "tag")
                    }
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button(role: .destructive) {
                        HapticFeedback.warning()
                        pendingSwipeDelete = item
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                    if item.status == "listed" || item.status == "active" {
                        Button {
                            Task { await perform(.dropPrice(percent: 10), items: [item], isBulk: false) }
                        } label: {
                            Label("-10%", systemImage: "arrow.down.circle")
                        }
                        .tint(Color.brandNavy)
                    }
                }
            }
            .listStyle(.plain)
            // US-193: drag images from Photos.app onto the list to
            // start a new item with them pre-staged. Multi-image drops
            // all flow into the same intake session.
            .acceptsImageDrops { images in
                handleDroppedImages(images)
            }
        }
    }

    // MARK: - Board (US-813)

    /// Kanban board layout. Shows every pipeline column; tap a card to open the
    /// canvas, long-press for "Move to…". Honors search + facet filters but not
    /// the stage tabs (it renders all stages as columns).
    private var board: some View {
        InventoryBoardView(items: boardItems) { item, status in
            await moveItem(item, to: status)
        }
    }

    /// Search/criteria-filtered items across ALL stages, for the board. Routed
    /// through the same memoized derivation as ``filteredItems`` (only one mode
    /// renders at a time, so they don't thrash the single cache slot); the
    /// `stage: .all` key keeps every pipeline status populated.
    private var boardItems: [LocalInventoryItem] {
        let key = InventoryDerivation.filterKey(
            itemsSignature: itemsSignature,
            stage: .all,
            query: debouncedQuery,
            sort: sortOption,
            criteria: criteria,
            soldDates: soldDates,
            serverSearchIds: searchService.matchedItemIds
        )
        return derivation.filteredItems(key: key) {
            InventoryFilter.apply(
                allItems,
                stage: .all,
                search: debouncedQuery,
                sort: sortOption,
                criteria: criteria,
                soldDates: soldDates,
                serverSearchIds: searchService.matchedItemIds,
                photoItemIds: photoItemIds(for: criteria)
            )
        }
    }

    /// Optimistic stage move from the board (US-813). The executor writes locally
    /// first, pushes to the server, and reverts the local row on failure; here we
    /// surface that failure via the existing error banner and a pull so a success
    /// reconciles with the server.
    private func moveItem(_ item: LocalInventoryItem, to status: String) async {
        if let error = await executor.moveStatus(item, to: status) {
            withAnimation(ReducedMotion.animation(.default)) { refreshError = "Move failed: \(error)" }
            HapticFeedback.error()
        } else {
            HapticFeedback.success()
            NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
        }
    }

    private func handleDroppedImages(_ images: [UIImage]) {
        // US-636: compression now runs off-main; do the staging in a Task.
        Task {
            let captures = await PhotosDropHandler.process(images)
            guard !captures.isEmpty else { return }
            AppRouter.haptic()
            // Map each capture onto the next available default slot in
            // declaration order (front, back, tag, detail). Extras spill
            // into defect slots if the user keeps dragging.
            let slots = (PhotoSlotType.defaultSlots + PhotoSlotType.defects)
                .map { CaptureSlot($0) }
            var mapping: [CaptureSlot: PhotoCapture] = [:]
            for (idx, capture) in captures.prefix(slots.count).enumerated() {
                mapping[slots[idx]] = capture
            }
            droppedCaptures = mapping
            showingDroppedIntake = true
        }
    }

    /// Standardized on ``ContentUnavailableView`` (like the rest of the app)
    /// and differentiated: an active search or active facet filter shows a
    /// "no matches" state (with a one-tap clear) rather than the stage's
    /// generic empty copy, so the user isn't told the stage is empty when
    /// it's really their filter.
    @ViewBuilder
    private var emptyState: some View {
        if !debouncedQuery.trimmingCharacters(in: .whitespaces).isEmpty {
            ContentUnavailableView.search(text: debouncedQuery)
        } else if criteria.isActive {
            ContentUnavailableView {
                Label("No matches", systemImage: "line.3.horizontal.decrease.circle")
            } description: {
                Text("No items in this stage match your filters.")
            } actions: {
                Button("Clear filters") {
                    AppRouter.haptic()
                    withAnimation(ReducedMotion.animation(.default)) { criteria = .empty }
                }
            }
        } else {
            ContentUnavailableView {
                Label(selectedStage.emptyStateTitle, systemImage: selectedStage.systemImage)
            } description: {
                Text(selectedStage.emptyStateSubtitle)
            }
        }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var syncToolbarItem: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                AppRouter.haptic()
                syncTask?.cancel()
                syncTask = Task { await runEbaySync() }
            } label: {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .accessibilityLabel("Sync from eBay")
            }
        }
    }

    private func runEbaySync() async {
        guard case let .signedIn(user) = authStore.phase else { return }
        let userId = user.id.uuidString

        syncStore.beginSync()
        sheet = .sync

        let service = EbaySyncService(container: modelContext.container, syncEngine: syncEngine)
        let baseline = await service.snapshot(userId: userId)
        let completion = await service.sync(userId: userId, baseline: baseline)
        // Modal dismissed mid-sync — the task was cancelled; don't apply a
        // result over the reset store or fire feedback for a sync the user left.
        if Task.isCancelled { return }
        syncStore.apply(completion)
        switch completion {
        case .completed:           HapticFeedback.success()
        case .timedOut:            HapticFeedback.warning()
        case .connectionFlagged,
             .failed:              HapticFeedback.error()
        }
    }

    /// Cancels an in-flight sync poll and resets the modal store. Called when
    /// the sync sheet is dismissed (US-1007).
    private func cancelSync() {
        syncTask?.cancel()
        syncTask = nil
        syncStore.reset()
    }

    @ToolbarContentBuilder
    private var selectToolbarItem: some ToolbarContent {
        // Multi-select bulk actions live on the list; the board uses per-card
        // "Move to…" instead, so the Select toggle is list-only.
        if viewMode == .list {
            ToolbarItem(placement: .topBarLeading) {
                Button(selection.isEditing ? "Done" : "Select") {
                    AppRouter.haptic()
                    selection.toggleEditing()
                }
                .font(.subheadline.weight(.semibold))
            }
        }
    }

    /// US-813: list ↔ board layout toggle. Shows the icon of the mode it switches
    /// TO so the affordance reads as an action.
    @ToolbarContentBuilder
    private var viewModeToolbarItem: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                AppRouter.haptic()
                let next: InventoryViewMode = viewMode == .list ? .board : .list
                // Leaving the list: drop any in-progress multi-selection so the
                // board doesn't inherit a stale edit mode.
                if next == .board, selection.isEditing { selection.toggleEditing() }
                withAnimation(ReducedMotion.animation(.default)) { viewMode = next }
            } label: {
                Image(systemName: viewMode == .list ? InventoryViewMode.board.systemImage : InventoryViewMode.list.systemImage)
                    .accessibilityLabel(viewMode == .list ? "Switch to board view" : "Switch to list view")
            }
        }
    }

    @ToolbarContentBuilder
    private var sortToolbarItem: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Section("Sort") {
                    ForEach(SortOption.allCases) { option in
                        Button {
                            sortOption = option
                        } label: {
                            if option == sortOption {
                                Label(option.label, systemImage: "checkmark")
                            } else {
                                Label(option.label, systemImage: option.systemImage)
                            }
                        }
                    }
                }
            } label: {
                Image(systemName: "arrow.up.arrow.down.circle")
                    .accessibilityLabel("Sort")
            }
        }
    }

    /// Filter entry point with a badge showing how many facets are active,
    /// so the user can tell the list is narrowed without scrolling the chip
    /// bar.
    @ToolbarContentBuilder
    private var filterToolbarItem: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                AppRouter.haptic()
                sheet = .filter
            } label: {
                Image(systemName: criteria.isActive
                      ? "line.3.horizontal.decrease.circle.fill"
                      : "line.3.horizontal.decrease.circle")
                    .overlay(alignment: .topTrailing) {
                        if criteria.activeCount > 0 {
                            Text("\(criteria.activeCount)")
                                .font(.system(size: 11, weight: .bold))
                                .foregroundStyle(.white)
                                .padding(3)
                                .frame(minWidth: 16, minHeight: 16)
                                .background(Color.brandRed, in: Circle())
                                .offset(x: 7, y: -7)
                        }
                    }
                    .accessibilityLabel(criteria.isActive
                        ? "Filters, \(criteria.activeCount) active"
                        : "Filters")
            }
        }
    }

    // MARK: - Derived state

    /// US-1017: cheap content signature of the item cache, gating all three
    /// memoized derivations below. See ``InventoryDerivation/itemsSignature(_:)``.
    private var itemsSignature: Int { InventoryDerivation.itemsSignature(allItems) }

    /// US-1017: memoized — the full filter+sort pass runs only when the items,
    /// stage, debounced query, sort, criteria, sold-date map, or server-search
    /// ids actually change; an unrelated `body` re-render returns the cached
    /// result.
    private var filteredItems: [LocalInventoryItem] {
        let key = InventoryDerivation.filterKey(
            itemsSignature: itemsSignature,
            stage: selectedStage,
            query: debouncedQuery,
            sort: sortOption,
            criteria: criteria,
            soldDates: soldDates,
            serverSearchIds: searchService.matchedItemIds,
            unlistedFilter: unlistedFilter
        )
        return derivation.filteredItems(key: key) {
            InventoryFilter.apply(
                allItems,
                stage: selectedStage,
                search: debouncedQuery,
                sort: sortOption,
                criteria: criteria,
                soldDates: soldDates,
                serverSearchIds: searchService.matchedItemIds,
                photoItemIds: photoItemIds(for: criteria),
                unlistedFilter: unlistedFilter
            )
        }
    }

    /// US-1017: memoized facet index for the filter sheet. Keyed on the item
    /// signature plus the source-name map (a rename changes labels only), so the
    /// derive runs at most once per filter-sheet presentation rather than on
    /// every body re-render while the sheet is up.
    private var facets: InventoryFacets {
        let key = InventoryDerivation.facetsKey(
            itemsSignature: itemsSignature,
            sourceNames: sourceNames
        )
        return derivation.facets(key: key) {
            InventoryFacets.derive(from: allItems, sourceNames: sourceNames)
        }
    }

    /// `sources.id` → display name, for the source facet + active chips.
    private var sourceNames: [String: String] {
        Dictionary(sources.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
    }

    /// US-1520: item ids with at least one cached photo — ONE id-level
    /// `LocalItemPhoto` fetch instead of faulting every item's lazy `photos`
    /// relationship inside the facet filter (a main-thread stall applying the
    /// with/missing-photo facet on a large catalog). Only materialized while a
    /// photo facet is active; memoized on the items signature (the same
    /// staleness contract the filtered-list memo already has).
    private func photoItemIds(for criteria: InventoryFilterCriteria) -> Set<String>? {
        guard criteria.photoState != .any else { return nil }
        return derivation.photoItemIds(key: itemsSignature) {
            var descriptor = FetchDescriptor<LocalItemPhoto>()
            // Only the FK is needed — don't materialize URLs/dimensions.
            descriptor.propertiesToFetch = [\.inventoryItemId]
            let photos = (try? modelContext.fetch(descriptor)) ?? []
            return Set(photos.map(\.inventoryItemId))
        }
    }

    /// `inventory_item_id` → most-recent linked sale date, for the sale-date
    /// facet. Keeps the latest sale when an item has more than one.
    private var soldDates: [String: Date] {
        var out: [String: Date] = [:]
        for sale in sales {
            if let existing = out[sale.inventoryItemId], existing >= sale.saleDate { continue }
            out[sale.inventoryItemId] = sale.saleDate
        }
        return out
    }

    /// Single-pass count of items per stage (US-639). Built once per render and
    /// looked up by each chip, replacing the previous per-chip full `.filter`.
    /// US-1017: additionally memoized on the item signature, so it recomputes
    /// only when the cache changes — not on unrelated `@State`-driven renders.
    private var stageCounts: [InventoryStage: Int] {
        derivation.stageCounts(key: itemsSignature) {
            var counts: [InventoryStage: Int] = [:]
            for item in allItems {
                for stage in InventoryStage.userFacing
                where stage.matchingStatuses.contains(item.status) {
                    counts[stage, default: 0] += 1
                }
            }
            return counts
        }
    }

    /// Item count the given criteria yields under the current stage +
    /// search — feeds the filter sheet's live "Show N items" footer.
    private func resultCount(for candidate: InventoryFilterCriteria) -> Int {
        InventoryFilter.apply(
            allItems,
            stage: selectedStage,
            search: debouncedQuery,
            sort: sortOption,
            criteria: candidate,
            soldDates: soldDates,
            serverSearchIds: searchService.matchedItemIds,
            photoItemIds: photoItemIds(for: candidate),
            unlistedFilter: unlistedFilter
        ).count
    }

    // MARK: - Refresh

    /// US-643: await the actual ``SyncEngine.sync()`` so the spinner reflects
    /// real completion, and surface a transient error on failure instead of a
    /// fixed sleep that always "succeeds".
    private func refreshFromServer() async {
        guard let syncEngine else {
            // Engine not booted yet (very early launch) — fall back to the
            // notification path so the pull isn't a dead gesture.
            NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
            return
        }
        let outcome = await syncEngine.sync()
        if case let .failed(message) = outcome {
            await MainActor.run {
                withAnimation(ReducedMotion.animation(.default)) { refreshError = message }
                HapticFeedback.error()
                // US-1021: announce the failure to VoiceOver (WCAG 4.1.3) —
                // a silent red capsule swap was previously inaudible.
                A11yAnnounce.announce(Self.refreshFailureAnnouncement(message))
            }
        }
    }

    /// US-1021: composed VoiceOver string for a pull-to-refresh failure. Pure +
    /// static so it's unit-testable (the `UIAccessibility.post` side effect
    /// no-ops without VoiceOver and isn't).
    static func refreshFailureAnnouncement(_ message: String) -> String {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Refresh failed." : "Refresh failed. \(trimmed)"
    }

    // MARK: - Bulk actions (US-182)

    private func runAction(_ action: BulkAction) async {
        let targets = allItems.filter { selection.selected.contains($0.id) }
        await perform(action, items: targets, isBulk: true)
    }

    /// Unified bulk/single execution (US-642 swipe + US-644 progress/undo).
    private func perform(_ action: BulkAction, items: [LocalInventoryItem], isBulk: Bool) async {
        guard !items.isEmpty else { return }
        AppRouter.haptic()

        // Snapshot pre-state for the undoable status actions before we mutate.
        let undoTargets: [(item: LocalInventoryItem, status: String)] =
            Self.isStatusUndoable(action) ? items.map { ($0, $0.status) } : []

        actionProgress = (0, items.count)
        let result = await executor.execute(action, items: items) { done, total in
            actionProgress = (done, total)
        }
        actionProgress = nil
        // US-1522: a successful single-item swipe is already confirmed by the undo
        // snackbar — don't ALSO pop a modal alert (double confirmation). Show the
        // alert only for bulk runs (the summary count matters) or when something
        // failed (the per-item reason / retry matters).
        if isBulk || !result.failures.isEmpty {
            actionResult = result
        }

        guard result.succeeded > 0 else { return }

        if isBulk, selection.isEditing { selection.toggleEditing() }

        // Offer Undo only where a clean local + server revert is safe (status
        // changes); end-listing isn't reversible so it's intentionally excluded.
        if !undoTargets.isEmpty {
            undoContext = BulkUndoContext(
                label: "\(action.label) · \(result.succeeded) item\(result.succeeded == 1 ? "" : "s")",
                revert: {
                    await executor.revertStatuses(undoTargets)
                    NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
                }
            )
        }
        NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
    }

    /// US-756: re-run the last bulk action against ONLY the items that failed,
    /// so a partial failure recovers without re-selecting and re-running the
    /// whole batch. Succeeded items are never touched; the new result replaces
    /// `actionResult`, so repeated retries keep narrowing to the still-failing
    /// set (and a fully-recovered retry shows "Updated N items."). The result is
    /// passed in rather than read from state because dismissing the alert that
    /// triggers this nils `actionResult` before the async work runs.
    private func retryFailed(_ result: BulkActionResult) async {
        guard !result.failures.isEmpty else { return }
        let failedIds = Self.failedItemIdsToRetry(result)
        let failedItems = allItems.filter { failedIds.contains($0.id) }
        guard !failedItems.isEmpty else { return }
        sheet = nil
        await perform(result.action, items: failedItems, isBulk: true)
    }

    /// The item ids to retry after a partial bulk failure — exactly the failed
    /// set. Pure + static so the "never re-runs the succeeded items" contract is
    /// unit-testable without a SwiftData container.
    static func failedItemIdsToRetry(_ result: BulkActionResult) -> Set<String> {
        Set(result.failures.map(\.itemId))
    }

    /// US-756: which actions a "Retry failed" makes sense for. Export is a
    /// client-side no-fail action and grade runs in its own sheet (never lands
    /// here), so neither offers a retry; everything else re-runs cleanly.
    static func isRetryable(_ action: BulkAction) -> Bool {
        switch action {
        case .exportCSV, .grade: return false
        default: return true
        }
    }

    /// True for status-only actions where Undo can safely restore the prior
    /// state on both the server and the local cache (US-644).
    private static func isStatusUndoable(_ action: BulkAction) -> Bool {
        switch action {
        case .createDraft, .markShipped: return true
        default: return false
        }
    }

    /// US-642 swipe delete: server delete then drop the local row.
    private func deleteItem(_ item: LocalInventoryItem) async {
        if let error = await executor.deleteItem(item) {
            withAnimation(ReducedMotion.animation(.default)) { refreshError = error }
            HapticFeedback.error()
        } else {
            modelContext.delete(item)
            modelContext.saveOrLog("deleteItem")
            HapticFeedback.success()
        }
    }
}

// MARK: - US-643 / US-1021 supporting views

/// Pull-to-refresh failure banner. Red capsule carrying the error plus a Retry
/// action and an explicit dismiss — replaces the old text-only auto-dismissing
/// capsule so the failure is actionable and (paired with `A11yAnnounce` +
/// VoiceOver-aware persistence in the parent) accessible.
private struct RefreshErrorBanner: View {
    let message: String
    var onRetry: () -> Void
    var onDismiss: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.white)
                .accessibilityHidden(true)
            Text(message)
                .font(.footnote.weight(.medium))
                .foregroundStyle(.white)
                .lineLimit(2)
            Spacer(minLength: 8)
            Button("Retry") {
                HapticFeedback.light()
                onRetry()
            }
            .font(.footnote.weight(.bold))
            .foregroundStyle(.white)
            Button {
                onDismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white)
            }
            .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Color.brandRed, in: Capsule())
        .shadow(radius: 6, y: 2)
        .padding(.horizontal, 16)
    }
}

// MARK: - US-644 supporting views

/// A short-lived undo descriptor for a completed bulk action.
struct BulkUndoContext: Identifiable {
    let id = UUID()
    let label: String
    let revert: () async -> Void
}

/// Bottom snackbar offering Undo after a bulk action. US-972: it owns a visible
/// countdown so the user can see how long the undo window stays open, and
/// auto-dismisses itself when the window closes rather than vanishing silently.
private struct BulkUndoBar: View {
    let context: BulkUndoContext
    /// Seconds the undo affordance stays available.
    var duration: Int = 6
    var onDismiss: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var remaining: Int = 6

    var body: some View {
        HStack(spacing: 12) {
            Text(context.label)
                .font(.footnote.weight(.medium))
                .foregroundStyle(.white)
                .lineLimit(1)
            Spacer(minLength: 8)
            // Countdown ring + remaining seconds so the time window is visible.
            ZStack {
                Circle()
                    .stroke(Color.white.opacity(0.25), lineWidth: 2)
                Circle()
                    .trim(from: 0, to: CGFloat(remaining) / CGFloat(max(duration, 1)))
                    .stroke(Color.brandAmber, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Text("\(remaining)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.white)
            }
            .frame(width: 22, height: 22)
            .accessibilityHidden(true)
            Button("Undo") {
                Task {
                    await context.revert()
                    HapticFeedback.success()
                    onDismiss()
                }
            }
            .font(.footnote.weight(.bold))
            .foregroundStyle(Color.brandAmber)
            .accessibilityLabel("Undo \(context.label), \(remaining) seconds left")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Color.brandNavy, in: Capsule())
        .shadow(radius: 8, y: 2)
        .padding(.horizontal, 16)
        .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
        // Restarts whenever a new bulk action replaces the context.
        .task(id: context.id) {
            remaining = duration
            while remaining > 0 {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if Task.isCancelled { return }
                withAnimation(ReducedMotion.animation(.default)) { remaining -= 1 }
            }
            onDismiss()
        }
    }
}

/// Determinate progress HUD shown during a multi-item bulk action.
private struct BulkProgressHUD: View {
    let done: Int
    let total: Int

    var body: some View {
        VStack(spacing: 10) {
            ProgressView(value: Double(done), total: Double(max(total, 1)))
                .progressViewStyle(.linear)
                .frame(width: 160)
            Text("\(done) of \(total)")
                .font(.footnote.weight(.medium))
                .foregroundStyle(.secondary)
        }
        .padding(20)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: CornerRadius.card, style: .continuous))
        .shadow(radius: 12)
    }
}

/// Per-item failure list (US-644) — resolves item titles from the cache.
/// US-756: offers a "Retry N failed" action so only the failed rows re-run.
private struct BulkFailuresView: View {
    let result: BulkActionResult
    let items: [LocalInventoryItem]
    /// Re-runs the action against only the failed set. Nil for non-retryable
    /// actions (export). Dismissal is handled by the parent's retry path.
    var onRetry: (() -> Void)?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(result.failures, id: \.itemId) { failure in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(title(for: failure.itemId))
                                .font(.subheadline.weight(.medium))
                            Text(failure.message)
                                .font(.caption)
                                .foregroundStyle(Color.brandRed)
                        }
                    }
                } header: {
                    Text("\(result.failures.count) failed · \(result.succeeded) succeeded")
                }
                if let onRetry {
                    Section {
                        Button {
                            onRetry()
                        } label: {
                            Label(
                                "Retry \(result.failures.count) failed item\(result.failures.count == 1 ? "" : "s")",
                                systemImage: "arrow.clockwise"
                            )
                        }
                    } footer: {
                        Text("Re-runs only the items that failed — the \(result.succeeded) that succeeded won't run again.")
                    }
                }
            }
            .navigationTitle(result.action.label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func title(for id: String) -> String {
        items.first { $0.id == id }?.title ?? id
    }
}

// MARK: - Notification bridge

extension Notification.Name {
    /// Pulled-to-refresh on the inventory list. ContentView observes
    /// and forwards to SyncEngine.sync().
    static let inventoryPullRequested = Notification.Name("com.gradethread.inventoryPullRequested")

    /// US-187: notification tap → MainShell mutates AppRouter to the
    /// right tab + path. Carries `DeepLinkRoute` under
    /// `DeepLinkRouter.routeUserInfoKey`.
    static let applyDeepLink = Notification.Name("com.gradethread.applyDeepLink")
}

// (ItemCanvasPlaceholder removed — US-181 ItemCanvasView is now the
// real destination.)
