import SwiftData
import SwiftUI

/// Value-based navigation marker so the grades list pushes correctly in both
/// the iPhone NavigationStack and the iPad NavigationSplitView detail column
/// (a plain destination NavigationLink doesn't push from a split-view content
/// column). Register with `.navigationDestination(for: GradesRoute.self)`.
struct GradesRoute: Hashable {}

/// A list of every inventory item that carries a certified grade. Gives
/// resellers one place to review grades, sort by score, and jump to an
/// item's canvas (where the full report + certificate live). Reads the
/// local SwiftData mirror, so it's instant + offline-friendly.
struct GradesListView: View {
    @Query(
        filter: #Predicate<LocalInventoryItem> { $0.gradeValue != nil },
        sort: \LocalInventoryItem.updatedAt,
        order: .reverse
    )
    private var gradedItems: [LocalInventoryItem]

    @State private var sort: GradeSort = .recent

    // US-1026: pull-to-refresh fires a real sync; the engine dedupes concurrent
    // pulls, and a transient banner surfaces failures.
    @Environment(\.syncEngine) private var syncEngine
    @State private var refreshError: String?

    enum GradeSort: String, CaseIterable, Identifiable {
        case recent, highest, lowest
        var id: String { rawValue }
        var label: String {
            switch self {
            case .recent:  return "Most recent"
            case .highest: return "Highest grade"
            case .lowest:  return "Lowest grade"
            }
        }
    }

    private var sorted: [LocalInventoryItem] {
        switch sort {
        case .recent:
            return gradedItems  // already updatedAt-descending from @Query
        case .highest:
            return gradedItems.sorted { ($0.gradeValue ?? 0) > ($1.gradeValue ?? 0) }
        case .lowest:
            return gradedItems.sorted { ($0.gradeValue ?? 0) < ($1.gradeValue ?? 0) }
        }
    }

    private var averageGrade: Double? {
        let values = gradedItems.compactMap(\.gradeValue)
        guard !values.isEmpty else { return nil }
        return values.reduce(0, +) / Double(values.count)
    }

    var body: some View {
        Group {
            if gradedItems.isEmpty {
                emptyState
            } else {
                list
            }
        }
        .navigationTitle("Certified grades")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !gradedItems.isEmpty {
                ToolbarItem(placement: .topBarTrailing) { sortMenu }
            }
        }
        .refreshable { await refreshFromServer() }
        .overlay(alignment: .bottom) { refreshErrorBanner }
    }

    /// US-1026: pull-to-refresh awaits a real ``SyncEngine.sync()`` so the
    /// spinner reflects true completion; the engine's own `isPulling` guard
    /// dedupes a refresh that lands while a sync is already running, and the
    /// local `@Query` re-renders when the merge notifies SwiftData.
    private func refreshFromServer() async {
        guard let syncEngine else {
            // Engine not booted yet — fall back to the notification path so the
            // pull isn't a dead gesture.
            NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
            return
        }
        if case let .failed(message) = await syncEngine.sync() {
            await MainActor.run { withAnimation { refreshError = message } }
        }
    }

    @ViewBuilder
    private var refreshErrorBanner: some View {
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

    private var list: some View {
        List {
            if let averageGrade {
                Section {
                    summaryRow(averageGrade: averageGrade)
                }
            }
            Section {
                ForEach(sorted) { item in
                    NavigationLink(value: item) {
                        GradeListRow(item: item)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private func summaryRow(averageGrade: Double) -> some View {
        HStack(spacing: 14) {
            GradeScoreRing(
                score: averageGrade,
                tier: "Average",
                diameter: 56,
                animateOnAppear: false
            )
            VStack(alignment: .leading, spacing: 2) {
                Text("\(gradedItems.count) certified item\(gradedItems.count == 1 ? "" : "s")")
                    .font(.subheadline.weight(.semibold))
                Text("Average grade \(String(format: "%.1f", averageGrade)) of 10")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }

    private var sortMenu: some View {
        Menu {
            Picker("Sort", selection: $sort) {
                ForEach(GradeSort.allCases) { option in
                    Text(option.label).tag(option)
                }
            }
        } label: {
            Label("Sort", systemImage: "arrow.up.arrow.down")
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No certified grades yet", systemImage: "checkmark.seal")
        } description: {
            Text("Open an item and tap “Get certified grade” to add a standardized condition grade and a buyer-facing certificate. Graded items show up here.")
        }
    }
}

/// One row in the grades list: mini score ring + title + tier + age.
private struct GradeListRow: View {
    let item: LocalInventoryItem

    private var daysAgo: Int {
        Calendar.current.dateComponents([.day], from: item.updatedAt, to: .now).day ?? 0
    }

    var body: some View {
        HStack(spacing: 12) {
            if let grade = item.gradeValue {
                GradeScoreRing(
                    score: grade,
                    tier: item.gradeLabel ?? "",
                    diameter: 44,
                    animateOnAppear: false
                )
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title.isEmpty ? "Untitled item" : item.title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
    }

    private var subtitle: String {
        var parts: [String] = []
        if let label = item.gradeLabel, !label.isEmpty { parts.append(label) }
        parts.append(daysAgo <= 0 ? "Graded today" : "Graded \(daysAgo)d ago")
        return parts.joined(separator: " · ")
    }
}
