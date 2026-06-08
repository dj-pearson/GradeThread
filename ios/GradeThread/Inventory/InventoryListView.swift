import SwiftData
import SwiftUI

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

    @Environment(\.syncEngine) private var syncEngine

    @State private var selectedStage: InventoryStage = .all
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
    @State private var showingFilterSheet = false
    @State private var savedFilters = SavedFilterStore()

    // US-182 multi-select
    @State private var selection = BulkSelectionStore()
    @State private var pendingAction: BulkAction?
    @State private var actionResult: BulkActionResult?
    private let executor = BulkActionExecutor()

    // US-642 swipe-delete confirmation
    @State private var pendingSwipeDelete: LocalInventoryItem?
    // US-644 progress + per-item failures + undo
    @State private var actionProgress: (done: Int, total: Int)?
    @State private var showingFailures = false
    @State private var undoContext: BulkUndoContext?

    // Bulk certified grading (its own sheet, not the confirmation-dialog path).
    @State private var showingBulkGrade = false
    @State private var bulkGradeTargetIds: [String] = []

    // US-184 sync
    @State private var syncStore = EbaySyncStore()
    @State private var showingSyncModal = false
    @Environment(\.modelContext) private var modelContext

    // US-193 drag-drop from Photos.app — captures live here until the
    // PhotoIntakeView mounts and seeds its own store from them.
    @State private var droppedCaptures: [PhotoSlotType: PhotoCapture] = [:]
    @State private var showingDroppedIntake = false

    var body: some View {
        VStack(spacing: 0) {
            tabRow
            ActiveFilterBar(criteria: $criteria)
            list
        }
        .navigationTitle("Inventory")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            sortToolbarItem
            filterToolbarItem
            selectToolbarItem
            syncToolbarItem
        }
        .sheet(isPresented: $showingFilterSheet) {
            InventoryFilterSheet(
                criteria: $criteria,
                facets: InventoryFacets.derive(from: allItems),
                savedFilters: savedFilters,
                resultCount: { resultCount(for: $0) }
            )
        }
        .sheet(isPresented: $showingSyncModal) {
            EbaySyncModal(store: syncStore, onDismiss: { syncStore.reset() })
        }
        .sheet(isPresented: $showingBulkGrade) {
            BulkGradeSheet(itemIds: bulkGradeTargetIds) {
                // Clear selection + exit edit mode, then pull so the new
                // grades land on each row.
                if selection.isEditing { selection.toggleEditing() }
                NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
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
                            showingBulkGrade = true
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
            if let result = actionResult, !result.failures.isEmpty {
                Button("View details") { showingFailures = true }
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
        // US-644: per-item failure detail.
        .sheet(isPresented: $showingFailures) {
            if let result = actionResult {
                BulkFailuresView(result: result, items: allItems)
            }
        }
        // US-644: progress HUD for longer multi-item batches.
        .overlay {
            if let progress = actionProgress, progress.total > 1 {
                BulkProgressHUD(done: progress.done, total: progress.total)
            }
        }
        // US-644: undo snackbar (auto-dismisses).
        .overlay(alignment: .bottom) {
            if let undo = undoContext {
                BulkUndoBar(context: undo) {
                    undoContext = nil
                }
                .padding(.bottom, selection.isEditing ? 80 : 24)
                .task(id: undo.id) {
                    try? await Task.sleep(nanoseconds: 6_000_000_000)
                    withAnimation { undoContext = nil }
                }
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
        // US-643: transient, non-blocking pull-to-refresh failure banner.
        .overlay(alignment: .bottom) {
            if let refreshError {
                Text(refreshError)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(Color.brandRed, in: Capsule())
                    .padding(.bottom, 24)
                    .shadow(radius: 6, y: 2)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .task(id: refreshError) {
                        try? await Task.sleep(nanoseconds: 3_500_000_000)
                        withAnimation { self.refreshError = nil }
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

    private func handleDroppedImages(_ images: [UIImage]) {
        // US-636: compression now runs off-main; do the staging in a Task.
        Task {
            let captures = await PhotosDropHandler.process(images)
            guard !captures.isEmpty else { return }
            AppRouter.haptic()
            // Map each capture onto the next available required slot in
            // declaration order (front, back, tag, detail). Extras spill
            // into defect slots if the user keeps dragging.
            let slots = PhotoSlotType.required + PhotoSlotType.defects
            var mapping: [PhotoSlotType: PhotoCapture] = [:]
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
                    withAnimation { criteria = .empty }
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
                Task { await runEbaySync() }
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
        showingSyncModal = true

        let service = EbaySyncService(container: modelContext.container)
        let baseline = await service.snapshot(userId: userId)
        let completion = await service.sync(userId: userId, baseline: baseline)
        syncStore.apply(completion)
        switch completion {
        case .completed:           HapticFeedback.success()
        case .timedOut:            HapticFeedback.warning()
        case .connectionFlagged,
             .failed:              HapticFeedback.error()
        }
    }

    @ToolbarContentBuilder
    private var selectToolbarItem: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button(selection.isEditing ? "Done" : "Select") {
                AppRouter.haptic()
                selection.toggleEditing()
            }
            .font(.subheadline.weight(.semibold))
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
                showingFilterSheet = true
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

    private var filteredItems: [LocalInventoryItem] {
        InventoryFilter.apply(
            allItems,
            stage: selectedStage,
            search: debouncedQuery,
            sort: sortOption,
            criteria: criteria
        )
    }

    /// Single-pass count of items per stage (US-639). Built once per render and
    /// looked up by each chip, replacing the previous per-chip full `.filter`.
    private var stageCounts: [InventoryStage: Int] {
        var counts: [InventoryStage: Int] = [:]
        for item in allItems {
            for stage in InventoryStage.userFacing
            where stage.matchingStatuses.contains(item.status) {
                counts[stage, default: 0] += 1
            }
        }
        return counts
    }

    /// Item count the given criteria yields under the current stage +
    /// search — feeds the filter sheet's live "Show N items" footer.
    private func resultCount(for candidate: InventoryFilterCriteria) -> Int {
        InventoryFilter.apply(
            allItems,
            stage: selectedStage,
            search: debouncedQuery,
            sort: sortOption,
            criteria: candidate
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
                withAnimation { refreshError = message }
                HapticFeedback.error()
            }
        }
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
        actionResult = result

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
            withAnimation { refreshError = error }
            HapticFeedback.error()
        } else {
            modelContext.delete(item)
            try? modelContext.save()
            HapticFeedback.success()
        }
    }
}

// MARK: - US-644 supporting views

/// A short-lived undo descriptor for a completed bulk action.
struct BulkUndoContext: Identifiable {
    let id = UUID()
    let label: String
    let revert: () async -> Void
}

/// Bottom snackbar offering Undo after a bulk action.
private struct BulkUndoBar: View {
    let context: BulkUndoContext
    var onDismiss: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Text(context.label)
                .font(.footnote.weight(.medium))
                .foregroundStyle(.white)
                .lineLimit(1)
            Spacer(minLength: 8)
            Button("Undo") {
                Task {
                    await context.revert()
                    HapticFeedback.success()
                    onDismiss()
                }
            }
            .font(.footnote.weight(.bold))
            .foregroundStyle(Color.brandAmber)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Color.brandNavy, in: Capsule())
        .shadow(radius: 8, y: 2)
        .padding(.horizontal, 16)
        .transition(.move(edge: .bottom).combined(with: .opacity))
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
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .shadow(radius: 12)
    }
}

/// Per-item failure list (US-644) — resolves item titles from the cache.
private struct BulkFailuresView: View {
    let result: BulkActionResult
    let items: [LocalInventoryItem]
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
