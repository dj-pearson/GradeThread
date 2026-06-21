import SwiftData
import SwiftUI

/// US-816 — bulk price-suggestions surface (iOS parity with web
/// `/dashboard/analytics/suggestions`). Lists items that lack a price or have
/// gone stale on the marketplace, fetches an eBay-comps median for each (server
/// app token, no user eBay connection needed), and offers one-tap Apply /
/// Dismiss per row. Entry point: the Money tab.
struct PriceSuggestionsView: View {
    @Environment(\.modelContext) private var modelContext

    @Query private var items: [LocalInventoryItem]
    @Query private var listings: [LocalListing]

    @State private var store = PriceSuggestionsStore()
    @State private var didStart = false

    private let currency = CurrencyFormatter()

    private var candidates: [PriceSuggestionCandidate] {
        PriceSuggestions.candidates(
            items: items.map {
                PriceSuggestionItemSnapshot(
                    id: $0.id, title: $0.title, brand: $0.brand, size: $0.size,
                    status: $0.status, targetPrice: $0.targetPrice,
                    listingPrice: $0.listingPrice
                )
            },
            listings: listings.map {
                PriceSuggestionListingSnapshot(
                    inventoryItemId: $0.inventoryItemId,
                    listingStatus: $0.listingStatus,
                    listingPrice: $0.listingPrice,
                    listedAt: $0.listedAt
                )
            },
            now: .now
        )
    }

    var body: some View {
        Group {
            if case let .failed(message) = store.phase {
                ErrorStateView(
                    title: "Couldn't load suggestions",
                    message: message,
                    retry: { await store.retry() }
                )
            } else if candidates.isEmpty {
                emptyState
            } else {
                content
            }
        }
        .navigationTitle("Price Suggestions")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard !didStart else { return }
            didStart = true
            await store.start(candidates: candidates)
        }
        // Transient success capsule (US-816 store convention).
        .overlay(alignment: .bottom) { banner }
        .alert(
            "Couldn't apply price",
            isPresented: Binding(
                get: { store.actionError != nil },
                set: { if !$0 { store.actionError = nil } }
            )
        ) {
            Button("OK", role: .cancel) { store.actionError = nil }
        } message: {
            Text(store.actionError ?? "")
        }
    }

    // MARK: - Content

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if case let .scanning(done, total) = store.phase {
                    progressCard(done: done, total: total)
                }

                ForEach(store.visibleRows) { row in
                    SuggestionRowView(
                        row: row,
                        currency: currency,
                        error: store.error(for: row),
                        busy: store.busy,
                        onApply: { Task { await store.apply(row) } },
                        onDismiss: { store.dismiss(row) }
                    )
                }

                if store.phase == .ready, store.visibleRows.isEmpty {
                    allHandledNote
                }
            }
            .padding(16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }

    private func progressCard(done: Int, total: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Checking eBay comps…")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(done)/\(total)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            ProgressView(value: Double(done), total: Double(max(total, 1)))
                .tint(Color.brandNavy)
        }
        .padding(16)
        .cardStyle(.flush)
    }

    private var allHandledNote: some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.seal.fill")
                .foregroundStyle(Color.brandEmerald)
            Text("All caught up — \(store.appliedCount) priced this session.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(16)
        .cardStyle(.flush)
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("Everything's priced", systemImage: "tag.circle")
        } description: {
            Text("Every active item already has a price and none have gone stale. New items without a price will show up here.")
        }
    }

    @ViewBuilder
    private var banner: some View {
        if let text = store.actionBanner {
            Text(text)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(Color.brandNavy, in: Capsule())
                .padding(.bottom, 16)
                .shadow(radius: 6, y: 2)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .task(id: text) {
                    try? await Task.sleep(for: .seconds(2.5))
                    store.actionBanner = nil
                }
        }
    }
}

// MARK: - Row

private struct SuggestionRowView: View {
    let row: PriceSuggestionsStore.Row
    let currency: CurrencyFormatter
    let error: String?
    let busy: Bool
    let onApply: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.candidate.title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(2)
                    Text(row.candidate.reason.label)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(Color.brandNavy)
                }
                Spacer()
                if row.candidate.hasDraft {
                    Image(systemName: "doc.text")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .accessibilityLabel("Has a draft listing")
                }
            }

            priceBlock

            if let error {
                Text(error)
                    .font(.caption2)
                    .foregroundStyle(Color.brandRed)
            }

            if row.state == .suggested {
                HStack(spacing: 10) {
                    Button(action: onApply) {
                        Label("Apply", systemImage: "checkmark")
                            .font(.caption.weight(.semibold))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.brandNavy)
                    .disabled(busy)

                    Button(action: onDismiss) {
                        Text("Dismiss")
                            .font(.caption.weight(.semibold))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .disabled(busy)
                }
            }
        }
        .padding(16)
        .cardStyle(.flush)
    }

    @ViewBuilder
    private var priceBlock: some View {
        switch row.state {
        case .pending:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Fetching comps…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        case .noComps:
            Text("No comparable eBay sales found — price this one manually.")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .suggested, .applied, .dismissed:
            if let suggestion = row.suggestion {
                HStack(alignment: .firstTextBaseline, spacing: 16) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Suggested")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Text(currency.formatDisplay(suggestion.suggestedPrice))
                            .font(.brandData(20, weight: .bold))
                            .foregroundStyle(Color.brandNavy)
                    }
                    if let current = row.candidate.currentPrice {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Current")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Text(currency.formatDisplay(current))
                                .font(.subheadline)
                                .strikethrough()
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                }
                Text(compContext(suggestion))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func compContext(_ suggestion: PriceSuggestion) -> String {
        var parts = ["\(suggestion.compCount) comp\(suggestion.compCount == 1 ? "" : "s")"]
        if let low = suggestion.low, let high = suggestion.high {
            parts.append("\(currency.formatDisplay(low))–\(currency.formatDisplay(high))")
        }
        return parts.joined(separator: " · ")
    }
}
