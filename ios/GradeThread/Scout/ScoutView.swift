import SwiftUI

/// ScoutAI: find underpriced eBay listings by their *condition*. Enter a
/// keyword and/or brand; ScoutAI grades the matching live listings from
/// their own photos and ranks the best condition-adjusted flips first.
///
/// Presented as a sheet from the Home tab (alongside Snap-to-Value). Paid
/// pro feature — on a free plan the scan returns a gate error which surfaces
/// inline.
struct ScoutView: View {
    /// US-3106: a term handed over from Prospect's demand strip. Seeds the
    /// keyword field and runs nothing on its own — a scan is a metered AI action
    /// and a chip tap is an intent to look, not an instruction to spend.
    var initialKeyword: String?

    @StateObject private var store = ScoutStore()
    @Environment(\.dismiss) private var dismiss
    /// US-1213: observe the app-wide plan-gate sink. A 402 from a scan routes
    /// through ``PlanGateNotifier`` (in ``ScoutService``), which presents the
    /// centralized upgrade-prompt → paywall sheet. When that prompt fires we
    /// suppress the inline "Try again" — a retry would just re-hit the gate; the
    /// upgrade CTA is the real recovery. Transient (network) failures don't set a
    /// gate, so they keep their retry button.
    @State private var planGate = PlanGateNotifier.shared
    /// US-1213: the gate that blocked the *current* failed scan, captured when
    /// ``PlanGateNotifier`` presents it. Held locally (not read off
    /// ``PlanGateNotifier/activePrompt``, which clears when the user dismisses
    /// the sheet) so the inline card stays in its "upgrade required" state and
    /// "See plans" can re-present, rather than reverting to a dead-end "Try
    /// again". Reset at the start of each scan.
    @State private var lockedGate: PlanGateError?
    /// US-3098: the deal-filter sheet.
    @State private var showFilters = false
    /// US-3106: one-shot, so re-rendering does not overwrite what the seller
    /// typed after the hand-off seeded the field.
    @State private var didSeedKeyword = false

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
            // US-1213: a 402 during the scan presents the centralized upgrade
            // prompt (sets `activePrompt`). Capture it so the inline error card
            // can drop its dead-end "Try again" and offer "See plans" instead —
            // and so it survives the user dismissing the sheet.
            .onChange(of: planGate.activePrompt) { _, gate in
                if let gate, store.isLoading || store.errorMessage != nil {
                    lockedGate = gate
                }
            }
            .sheet(isPresented: $showFilters) {
                ScoutFilterSheet(store: store, onApply: runScan)
            }
            // US-3106: seed the field from a demand chip, once. Never runs the
            // scan: that is a metered AI action, and "show me what people want"
            // is not "spend one of my scans on it".
            .onAppear {
                guard !didSeedKeyword,
                      let initialKeyword,
                      !initialKeyword.trimmingCharacters(in: .whitespaces).isEmpty else { return }
                didSeedKeyword = true
                store.keyword = initialKeyword
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

            // US-3098: the deal filter, behind one row rather than six fields.
            // A seller who just wants to look does not need them between
            // themselves and the button; one who is hunting a margin sets them
            // once and they persist across launches.
            Button {
                showFilters = true
            } label: {
                HStack {
                    Label(String(localized: "Deal filter"), systemImage: "line.3.horizontal.decrease.circle")
                    Spacer()
                    if let summary = filterSummary {
                        Text(summary)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                }
                .font(.caption)
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, alignment: .leading)

            Button(action: runScan) {
                if store.isLoading {
                    ProgressView().frame(maxWidth: .infinity)
                } else {
                    Label("Find deals", systemImage: "magnifyingglass")
                        .frame(maxWidth: .infinity)
                }
            }
            // US-690: brand primary CTA.
            .buttonStyle(.brandPrimary)
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
                .foregroundStyle(.brandAmber)
            // US-3107: two claims, and the second one used to be missing. The
            // value and ROI beside every result are computed from ACTIVE
            // listings — asking prices — because the Marketplace Insights grant
            // that would make them sold prices has not landed. A seller reading
            // "condition-matched comps" has no way to tell which of the two they
            // are being shown, and they price differently.
            Text("Shadow grades are private AI estimates from each listing's photos — not a GradeThread certificate, and not visible to the seller. Values come from active eBay listings, so they are asking prices, not sold prices. Always verify condition before buying.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.brandAmber.opacity(0.10), in: RoundedRectangle(cornerRadius: CornerRadius.control))
    }

    /// A one-line read of what is set, for the collapsed row. Nil when nothing
    /// is, so the row does not carry an empty trailing space.
    private var filterSummary: String? {
        var parts: [String] = []
        if let cap = ScoutStore.cents(from: store.maxTotalText) {
            parts.append(String(localized: "under \(CurrencyFormatter.shared.formatDisplay(Double(cap) / 100))"))
        }
        if let pct = ScoutStore.fraction(fromPercent: store.minMarginPctText) {
            parts.append(String(localized: "\(Int((pct * 100).rounded()))%+"))
        }
        if let margin = ScoutStore.cents(from: store.minMarginDollarsText) {
            parts.append(CurrencyFormatter.shared.formatDisplay(Double(margin) / 100) + "+")
        }
        if store.buyItNowOnly { parts.append(String(localized: "BIN")) }
        if store.freeShippingOnly { parts.append(String(localized: "free ship")) }
        if store.browseSort != .bestMatch { parts.append(store.browseSort.label.lowercased()) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
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
                // US-1166: lazy so rows + their CachedThumbnail network images
                // don't all instantiate eagerly inside the ScrollView.
                LazyVStack(spacing: 12) {
                    ForEach(store.displayedCandidates) { candidate in
                        ScoutCandidateRow(
                            candidate: candidate,
                            isBuying: store.buyingItemId == candidate.itemId,
                            isBought: store.boughtItemIds[candidate.itemId] != nil,
                            onBuy: { Task { await store.buy(candidate) } }
                        )
                    }
                }
                if let buyError = store.buyError {
                    Text(buyError)
                        .font(.caption)
                        .foregroundStyle(Color.brandRed)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private func resultsHeader(scanned: Int) -> some View {
        VStack(spacing: 8) {
            HStack {
                // US-3098: the denominator. "Graded 8" alone is a number a
                // seller cannot judge; "looked at 42, graded 8" says the scan
                // searched wider than the eight rows in front of them.
                Text("\(store.scanSummary ?? String(localized: "Scanned \(scanned) listings")) · \(store.displayedCandidates.count) shown")
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

    @ViewBuilder
    private func errorCard(_ message: String) -> some View {
        // US-1213: a plan-gated (402) failure is handled by the centralized
        // upgrade prompt — drop the dead-end "Try again" (it would just re-hit
        // the gate) and point the user at that flow instead. Transient errors
        // keep the retry button, which is the right recovery for them.
        if isFeatureLocked {
            ContentUnavailableView {
                Label("Upgrade required", systemImage: "lock.circle")
            } description: {
                Text(message)
            } actions: {
                Button("See plans") {
                    AppRouter.haptic()
                    // Re-present the centralized upgrade prompt (cleared if the
                    // user dismissed it); `isFeatureLocked` guarantees non-nil.
                    planGate.activePrompt = lockedGate
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.brandNavy)
            }
            .frame(maxWidth: .infinity)
        } else {
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
    }

    /// US-1213: true when the current failure is a plan gate (402) rather than a
    /// transient error. The scan path routes 402s through ``PlanGateNotifier``
    /// before throwing, which we capture into ``lockedGate``; a captured gate
    /// alongside a live error message means this failure is the plan gate.
    private var isFeatureLocked: Bool {
        store.errorMessage != nil && lockedGate != nil
    }

    // MARK: - Actions

    private func runScan() {
        guard store.canSearch else { return }
        // US-1213: clear any prior plan-gate capture so a fresh transient
        // failure shows "Try again", not a stale "upgrade required" card.
        lockedGate = nil
        AppRouter.haptic()
        Task { await store.scan() }
    }
}
