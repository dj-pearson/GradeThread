import SwiftUI

/// US-666 — payout reconciliation. Lists unreconciled eBay payouts with their
/// best-guess sale matches; the user confirms a match, picks an alternative, or
/// dismisses a payout that isn't a tracked sale. "Auto-match" runs the server
/// sweep for the unambiguous ones. Reached from the Money tab.
struct PayoutReconciliationView: View {
    @State private var store = PayoutReconciliationStore()
    private let currency = CurrencyFormatter()

    var body: some View {
        Group {
            switch store.phase {
            case .idle, .loading where store.entries.isEmpty:
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message):
                // US-971: shared error state keeps the retry affordance uniform
                // with the other data screens.
                ErrorStateView(
                    title: "Couldn't load payouts",
                    message: message,
                    retry: { await store.load() }
                )
            default:
                content
            }
        }
        .navigationTitle("Payout reconciliation")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await store.runAutoMatch() }
                } label: {
                    if store.isRunning { ProgressView() } else { Text("Auto-match") }
                }
                .disabled(store.isRunning || store.entries.isEmpty)
            }
        }
        .task { await store.load() }
        .refreshable { await store.load() }
        .alert("Couldn't update", isPresented: Binding(
            get: { store.actionError != nil },
            set: { if !$0 { store.actionError = nil } }
        )) {
            Button("OK", role: .cancel) { store.actionError = nil }
        } message: {
            Text(store.actionError ?? "")
        }
    }

    @ViewBuilder
    private var content: some View {
        if store.entries.isEmpty {
            ContentUnavailableView {
                Label("All caught up", systemImage: "checkmark.seal")
            } description: {
                Text("Every imported payout is matched to a sale. New payouts appear here after an eBay sync.")
            }
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let run = store.lastRun {
                        runBanner(run)
                    }
                    Text("\(store.unreconciledCount) payout\(store.unreconciledCount == 1 ? "" : "s") to reconcile")
                        .font(.footnote).foregroundStyle(.secondary)
                    ForEach(store.entries) { entry in
                        payoutCard(entry)
                    }
                }
                .padding(16)
            }
            .background(Color(uiColor: .systemGroupedBackground))
        }
    }

    private func runBanner(_ run: PayoutRunResult) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "wand.and.stars").foregroundStyle(Color.brandEmerald)
            Text("Auto-matched \(run.autoMatched) of \(run.scanned). \(run.ambiguous) need review, \(run.noCandidates) had no match.")
                .font(.caption)
            Spacer(minLength: 0)
        }
        .padding(16)
        .cardStyle(.flush)
    }

    private func payoutCard(_ entry: PayoutQueueEntry) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(currency.formatDisplay(entry.payoutImport.amount))
                        .font(.brandHeadline).monospacedDigit()
                    Text("Paid \(PayoutDateFormat.display(entry.payoutImport.payoutDate))")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if store.isBusy(entry) { ProgressView() }
            }

            if entry.candidates.isEmpty {
                Text("No likely sale match found.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Divider()
                ForEach(entry.candidates) { candidate in
                    candidateRow(entry, candidate)
                }
            }

            Button(role: .destructive) {
                Task { await store.dismiss(entry) }
            } label: {
                Label("Dismiss (not a tracked sale)", systemImage: "xmark.circle")
                    .font(.caption)
            }
            .disabled(store.isBusy(entry))
        }
        .padding(16)
        .cardStyle(.flush)
    }

    private func candidateRow(_ entry: PayoutQueueEntry, _ candidate: PayoutCandidate) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(candidate.itemTitle ?? "Untitled item")
                    .font(.subheadline.weight(.medium)).lineLimit(1)
                HStack(spacing: 8) {
                    Text(currency.formatDisplay(candidate.payoutAmount ?? candidate.salePrice))
                        .monospacedDigit()
                    Text("·")
                    Text(PayoutDateFormat.display(candidate.saleDate))
                }
                .font(.caption).foregroundStyle(.secondary)
                if let reason = candidate.reasons.first {
                    Text("\(candidate.scorePercent)% · \(reason)")
                        .font(.caption2).foregroundStyle(.tertiary)
                }
            }
            Spacer()
            Button("Match") {
                Task { await store.match(entry, to: candidate) }
            }
            .font(.caption.weight(.semibold))
            .buttonStyle(.borderedProminent)
            .tint(Color.brandNavy)
            .disabled(store.isBusy(entry))
        }
        .padding(.vertical, 4)
    }
}
