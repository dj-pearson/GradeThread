import SwiftUI

/// Sheet shown while the eBay sync runs and afterwards to display the
/// summary. The same view handles every phase — different bodies render
/// per the store's current phase.
struct EbaySyncModal: View {
    @Environment(\.dismiss) private var dismiss
    let store: EbaySyncStore
    let onDismiss: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemGroupedBackground).ignoresSafeArea())
        .presentationDetents([.medium])
        .interactiveDismissDisabled(!canDismissInteractively)
    }

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .idle, .starting:
            startingBody
        case .syncing:
            syncingBody
        case .completed(let summary):
            completedBody(summary)
        case .timedOut:
            timedOutBody
        case .connectionFlagged(let message):
            failedBody(
                title: "Connection flagged",
                message: message,
                icon: "exclamationmark.triangle.fill",
                color: .orange,
                retryLabel: "Reconnect on Marketplaces"
            )
        case .failed(let message):
            failedBody(
                title: "Sync failed",
                message: message,
                icon: "xmark.octagon.fill",
                color: .red,
                retryLabel: "Close"
            )
        }
    }

    private var canDismissInteractively: Bool {
        switch store.phase {
        case .idle, .completed, .timedOut, .connectionFlagged, .failed: return true
        case .starting, .syncing: return false
        }
    }

    // MARK: - Phase bodies

    private var startingBody: some View {
        VStack(spacing: 14) {
            ProgressView().tint(Color.brandNavy)
            Text("Starting sync…")
                .font(.headline)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var syncingBody: some View {
        VStack(spacing: 16) {
            ProgressView().tint(Color.brandNavy).scaleEffect(1.3)
            Text(store.phase.stageLabel ?? "Syncing…")
                .font(.headline)
            Text("This usually takes 30–60 seconds for an established account.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func completedBody(_ summary: EbaySyncSummary) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 48))
                .foregroundStyle(.green)
            Text("Sync complete")
                .font(.title3.weight(.semibold))

            VStack(spacing: 8) {
                summaryRow(
                    label: "Listings",
                    count: summary.listingsCount,
                    delta: summary.listingsDelta
                )
                summaryRow(
                    label: "Active",
                    count: summary.activeListingsCount,
                    delta: nil
                )
                summaryRow(
                    label: "Sales",
                    count: summary.salesCount,
                    delta: summary.salesDelta
                )
            }
            .padding(14)
            .background(Color(uiColor: .secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .padding(.horizontal, 16)

            Button {
                onDismiss()
                dismiss()
            } label: {
                Text("Done")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Color.brandNavy)
                    .foregroundStyle(.white)
                    .clipShape(Capsule())
            }
            .padding(.horizontal, 32)
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.vertical, 24)
    }

    private var timedOutBody: some View {
        VStack(spacing: 14) {
            Image(systemName: "clock.badge.exclamationmark")
                .font(.system(size: 44))
                .foregroundStyle(.orange)
            Text("Still syncing in the background")
                .font(.headline)
                .multilineTextAlignment(.center)
            Text("eBay didn't finish in the time we waited. Pull-to-refresh the list in a minute or two — fresh items will show up automatically.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
            Button {
                onDismiss()
                dismiss()
            } label: {
                Text("Close")
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 18)
                    .padding(.vertical, 10)
                    .background(Color.brandNavy)
                    .foregroundStyle(.white)
                    .clipShape(Capsule())
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    private func failedBody(
        title: String,
        message: String,
        icon: String,
        color: Color,
        retryLabel: String
    ) -> some View {
        VStack(spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 44))
                .foregroundStyle(color)
            Text(title)
                .font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
            Button {
                onDismiss()
                dismiss()
            } label: {
                Text(retryLabel)
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 18)
                    .padding(.vertical, 10)
                    .background(Color.brandNavy)
                    .foregroundStyle(.white)
                    .clipShape(Capsule())
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    // MARK: - Summary row

    private func summaryRow(label: String, count: Int, delta: Int?) -> some View {
        HStack {
            Text(label).font(.subheadline)
            Spacer()
            HStack(spacing: 6) {
                Text("\(count)")
                    .font(.subheadline.weight(.semibold))
                if let delta, delta != 0 {
                    Text(delta > 0 ? "+\(delta)" : "\(delta)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(delta > 0 ? .green : .secondary)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background((delta > 0 ? Color.green : Color.secondary).opacity(0.12))
                        .clipShape(Capsule())
                }
            }
        }
    }
}
