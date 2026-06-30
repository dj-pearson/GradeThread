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
        // US-1411: trap VoiceOver focus inside the sheet (WCAG 4.1.3) so focus
        // can't wander to the content behind it.
        .accessibilityAddTraits(.isModal)
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
                color: .brandAmber,
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

    // Always dismissable. The pull runs server-side (the edge returns 202 and
    // works in the background); closing the sheet only stops us watching it —
    // freshly-synced items still arrive via the next list refresh. Trapping
    // the user behind a 90s spinner with no escape was the bug.
    private var canDismissInteractively: Bool { true }

    /// Lets the user leave the spinner while the sync keeps running server-side.
    private var continueInBackgroundButton: some View {
        Button {
            onDismiss()
            dismiss()
        } label: {
            Text("Continue in background")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.brandNavy)
                .padding(.horizontal, 18)
                .padding(.vertical, 10)
        }
    }

    // MARK: - Phase bodies

    private var startingBody: some View {
        VStack(spacing: 14) {
            ProgressView().tint(Color.brandNavy)
            Text("Starting sync…")
                .font(.brandHeadline)
            continueInBackgroundButton
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var syncingBody: some View {
        VStack(spacing: 16) {
            ProgressView().tint(Color.brandNavy).scaleEffect(1.3)
            Text(store.phase.stageLabel ?? "Syncing…")
                .font(.brandHeadline)
            Text("This usually takes 30–60 seconds for an established account. You can keep using the app while it finishes.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
            continueInBackgroundButton
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func completedBody(_ summary: EbaySyncSummary) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "checkmark.circle.fill")
                .scaledIconFont(size: 48)  // US-1411: honor Dynamic Type
                .foregroundStyle(.brandEmerald)
            Text("Sync complete")
                .font(.brandTitle2)

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
            .cardStyle(.flush)  // US-691: unified card chrome
            .padding(.horizontal, 16)

            Button {
                onDismiss()
                dismiss()
            } label: {
                Text("Done")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 44)  // US-1411: 44pt tap target
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
        // US-1411: announce the in-place phase change for VoiceOver (WCAG 4.1.3).
        .onAppear { A11yAnnounce.screenChanged(focusing: "Sync complete") }
    }

    private var timedOutBody: some View {
        VStack(spacing: 14) {
            Image(systemName: "clock.badge.exclamationmark")
                .scaledIconFont(size: 44)  // US-1411: honor Dynamic Type
                .foregroundStyle(.brandAmber)
            Text("Still syncing in the background")
                .font(.brandHeadline)
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
                    .frame(minHeight: 44)  // US-1411: 44pt tap target
                    .background(Color.brandNavy)
                    .foregroundStyle(.white)
                    .clipShape(Capsule())
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
        // US-1411: announce the timeout for VoiceOver (WCAG 4.1.3).
        .onAppear { A11yAnnounce.screenChanged(focusing: "Still syncing in the background") }
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
                .scaledIconFont(size: 44)  // US-1411: honor Dynamic Type
                .foregroundStyle(color)
            Text(title)
                .font(.brandHeadline)
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
                    .frame(minHeight: 44)  // US-1411: 44pt tap target
                    .background(Color.brandNavy)
                    .foregroundStyle(.white)
                    .clipShape(Capsule())
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
        // US-1411: announce the failure for VoiceOver (WCAG 4.1.3).
        .onAppear { A11yAnnounce.screenChanged(focusing: title) }
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
                        .foregroundStyle(delta > 0 ? .brandEmerald : .secondary)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background((delta > 0 ? Color.brandEmerald : Color.secondary).opacity(0.12))
                        .clipShape(Capsule())
                }
            }
        }
    }
}
