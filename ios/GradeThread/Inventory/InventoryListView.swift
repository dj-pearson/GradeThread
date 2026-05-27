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

    var body: some View {
        VStack(spacing: 0) {
            tabRow
            list
        }
        .navigationTitle("Inventory")
        .navigationBarTitleDisplayMode(.large)
        .toolbar { sortToolbarItem }
        .searchable(
            text: $searchQuery,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Search title, brand, SKU"
        )
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
            List(filtered) { item in
                NavigationLink {
                    ItemCanvasPlaceholder(item: item)
                } label: {
                    InventoryRow(item: item)
                }
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
}

// MARK: - Notification bridge

extension Notification.Name {
    /// Pulled-to-refresh on the inventory list. ContentView observes
    /// and forwards to SyncEngine.sync().
    static let inventoryPullRequested = Notification.Name("com.gradethread.inventoryPullRequested")
}

// MARK: - Placeholder detail

/// Stub destination until US-181's real item canvas lands. Shows the
/// item's basic fields so the navigation push is at least informative.
struct ItemCanvasPlaceholder: View {
    let item: LocalInventoryItem

    var body: some View {
        Form {
            Section("Item") {
                LabeledContent("Title", value: item.title)
                if let brand = item.brand { LabeledContent("Brand", value: brand) }
                if let size = item.size { LabeledContent("Size", value: size) }
                if let color = item.color { LabeledContent("Color", value: color) }
                if let material = item.material { LabeledContent("Material", value: material) }
                LabeledContent("Status", value: item.status.capitalized)
            }
            if let grade = item.gradeValue {
                Section("Grade") {
                    LabeledContent("Score", value: String(format: "%.1f", grade))
                    if let label = item.gradeLabel { LabeledContent("Tier", value: label) }
                }
            }
            Section {
                Text("Full item canvas + inline editing lands in US-181.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle(item.title)
        .navigationBarTitleDisplayMode(.inline)
    }
}
