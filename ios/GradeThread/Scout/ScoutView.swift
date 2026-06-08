import SwiftUI

/// ScoutAI: find underpriced eBay listings by their *condition*. Enter a
/// keyword and/or brand; ScoutAI grades the matching live listings from
/// their own photos and ranks the best condition-adjusted flips first.
///
/// Presented as a sheet from the Home tab (alongside Snap-to-Value). Paid
/// pro feature — on a free plan the scan returns a gate error which surfaces
/// inline.
struct ScoutView: View {
    @StateObject private var store = ScoutStore()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    intro
                    searchCard
                    disclaimer
                    resultsSection
                }
                .padding(16)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("ScoutAI")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
    }

    // MARK: - Header

    private var intro: some View {
        Text("Find underpriced gems. ScoutAI grades live eBay listings from their own photos and flags the ones priced like they're in worse shape than they really are.")
            .font(.subheadline)
            .foregroundStyle(.secondary)
    }

    // MARK: - Search

    private var searchCard: some View {
        VStack(spacing: 10) {
            TextField("Search, e.g. Patagonia Better Sweater", text: $store.keyword)
                .textFieldStyle(.roundedBorder)
                .submitLabel(.search)
                .onSubmit(runScan)
            TextField("Brand (optional)", text: $store.brand)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .onSubmit(runScan)

            Button(action: runScan) {
                if store.isLoading {
                    ProgressView().frame(maxWidth: .infinity)
                } else {
                    Label("Find deals", systemImage: "magnifyingglass")
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.brandNavy)
            .disabled(!store.canSearch)

            Text("Searches eBay apparel by default; a keyword sharpens the category for tighter comps.")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(16)
        .cardStyle(.flush)
    }

    private var disclaimer: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "info.circle")
                .foregroundStyle(.orange)
            Text("Shadow grades are private AI estimates from each listing's photos — not a GradeThread certificate, and not visible to the seller. Always verify condition before buying.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: CornerRadius.control))
    }

    // MARK: - Results

    @ViewBuilder
    private var resultsSection: some View {
        if let message = store.errorMessage {
            errorCard(message)
        } else if store.isLoading {
            VStack(spacing: 12) {
                SkeletonBlock(cornerRadius: CornerRadius.card).frame(height: 150)
                SkeletonBlock(cornerRadius: CornerRadius.card).frame(height: 150)
            }
        } else if let response = store.response {
            if store.displayedCandidates.isEmpty {
                emptyResults(note: response.note)
            } else {
                resultsHeader(scanned: response.scanned)
                ForEach(store.displayedCandidates) { candidate in
                    ScoutCandidateRow(candidate: candidate)
                }
            }
        }
    }

    private func resultsHeader(scanned: Int) -> some View {
        VStack(spacing: 8) {
            HStack {
                Text("Scanned \(scanned) · \(store.displayedCandidates.count) shown")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Menu {
                    Picker("Sort", selection: $store.sortKey) {
                        ForEach(ScoutStore.SortKey.allCases) { key in
                            Text(key.label).tag(key)
                        }
                    }
                } label: {
                    Label(store.sortKey.label, systemImage: "arrow.up.arrow.down")
                        .font(.caption.weight(.semibold))
                }
            }
            HStack {
                Label("Category: \(store.categoryLabel)", systemImage: "tag")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer()
                Toggle("Actionable only", isOn: $store.actionableOnly)
                    .toggleStyle(.button)
                    .font(.caption.weight(.semibold))
                    .tint(Color.brandNavy)
            }
        }
    }

    private func emptyResults(note: String?) -> some View {
        ContentUnavailableView {
            Label("No candidates", systemImage: "magnifyingglass")
        } description: {
            Text(note ?? "No listings matched that search. Try broader terms or a different brand.")
        }
        .frame(maxWidth: .infinity)
    }

    private func errorCard(_ message: String) -> some View {
        ContentUnavailableView {
            Label("Scan failed", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("Try again", action: runScan)
                .buttonStyle(.borderedProminent)
                .tint(Color.brandNavy)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Actions

    private func runScan() {
        guard store.canSearch else { return }
        AppRouter.haptic()
        Task { await store.scan() }
    }
}
