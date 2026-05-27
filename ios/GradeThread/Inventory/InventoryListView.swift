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

    @State private var selectedStage: InventoryStage = .all
    @State private var searchQuery: String = ""
    @State private var sortOption: SortOption = .newest

    // US-182 multi-select
    @State private var selection = BulkSelectionStore()
    @State private var pendingAction: BulkAction?
    @State private var actionResult: BulkActionResult?
    private let executor = BulkActionExecutor()

    // US-184 sync
    @State private var syncStore = EbaySyncStore()
    @State private var showingSyncModal = false
    @Environment(\.modelContext) private var modelContext

    var body: some View {
        VStack(spacing: 0) {
            tabRow
            list
        }
        .navigationTitle("Inventory")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            sortToolbarItem
            selectToolbarItem
            syncToolbarItem
        }
        .sheet(isPresented: $showingSyncModal) {
            EbaySyncModal(store: syncStore, onDismiss: { syncStore.reset() })
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
                    onAction: { action in pendingAction = action },
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
            Button("OK") {}
        }
        .refreshable {
            // Triggered by the user pulling the list down. SyncEngine
            // pulls fresh rows from Supabase and merges; the local
            // @Query re-renders when SwiftData notifies.
            await refreshFromServer()
        }
    }

    // MARK: - Layout

    private var tabRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(InventoryStage.userFacing) { stage in
                    Button {
                        AppRouter.haptic()
                        selectedStage = stage
                    } label: {
                        tabChip(for: stage)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .background(Color(uiColor: .systemBackground))
    }

    private func tabChip(for stage: InventoryStage) -> some View {
        let count = stageCount(stage)
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
            List(filtered, selection: $selection.selected) { item in
                NavigationLink {
                    ItemCanvasView(item: item)
                } label: {
                    InventoryRow(item: item)
                }
                .tag(item.id)
            }
            .listStyle(.plain)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: selectedStage.systemImage)
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(Color.brandNavy)
            Text(selectedStage.emptyStateTitle)
                .font(.headline)
            Text(selectedStage.emptyStateSubtitle)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
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
            } label: {
                Image(systemName: "arrow.up.arrow.down.circle")
                    .accessibilityLabel("Sort options")
            }
        }
    }

    // MARK: - Derived state

    private var filteredItems: [LocalInventoryItem] {
        InventoryFilter.apply(
            allItems,
            stage: selectedStage,
            search: searchQuery,
            sort: sortOption
        )
    }

    private func stageCount(_ stage: InventoryStage) -> Int {
        allItems.filter { stage.matchingStatuses.contains($0.status) }.count
    }

    // MARK: - Refresh

    private func refreshFromServer() async {
        // No explicit @Environment for the SyncEngine because it lives
        // on the ContentView level — we trigger a sync via a
        // notification post that ContentView listens for. Simpler than
        // threading an actor handle through the environment.
        NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)

        // Give the engine a beat to start so the spinner stays visible
        // until the first batch lands.
        try? await Task.sleep(nanoseconds: 700_000_000)
    }

    // MARK: - Bulk actions (US-182)

    private func runAction(_ action: BulkAction) async {
        let targets = allItems.filter { selection.selected.contains($0.id) }
        guard !targets.isEmpty else { return }
        AppRouter.haptic()
        let result = await executor.execute(action, items: targets)
        actionResult = result
        if result.succeeded > 0 {
            // Clear selection + exit edit mode on at least partial
            // success — matches the AC "Selection cleared after a
            // successful bulk action". Sync to pick up server-side
            // ripple effects (e.g. items_full recomputing).
            selection.toggleEditing()
            NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
        }
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
