import SwiftUI

/// The Repricing inbox: condition-aware price suggestions for active eBay
/// listings, each applied or dismissed with one tap. Pushed from the Money
/// tab. Suggestions are produced server-side (a periodic scan); the toolbar
/// "Scan" button forces a fresh pass.
struct RepricingView: View {
    @State private var store = RepricingStore()
    /// US-981: gate the network-only scan / apply actions when offline.
    @Environment(NetworkMonitor.self) private var networkMonitor: NetworkMonitor?

    private var isOffline: Bool { NetworkMonitor.isOffline(networkMonitor) }

    var body: some View {
        content
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("Repricing")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { scanToolbarItem }
            .task { if store.suggestions.isEmpty { await store.load() } }
            .refreshable { await store.load() }
            .overlay(alignment: .bottom) { bannerView }
            .task(id: store.banner) {
                guard store.banner != nil else { return }
                try? await Task.sleep(for: .seconds(2.5))
                withAnimation { store.banner = nil }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .loading:
            ScrollView {
                VStack(spacing: 12) {
                    ForEach(0..<3, id: \.self) { _ in
                        SkeletonBlock(cornerRadius: CornerRadius.card).frame(height: 150)
                    }
                }
                .padding(16)
            }

        case .failed(let message):
            ContentUnavailableView {
                Label("Couldn't load suggestions", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") { Task { await store.load() } }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.brandNavy)
            }

        case .loaded where store.suggestions.isEmpty:
            emptyState

        case .loaded:
            list
        }
    }

    private var list: some View {
        ScrollView {
            VStack(spacing: 12) {
                summaryHeader
                if isOffline {
                    OfflineNotice(intent: .blocked, detail: "to apply price changes")
                }
                ForEach(store.suggestions) { suggestion in
                    RepricingCard(
                        suggestion: suggestion,
                        isBusy: store.inFlight.contains(suggestion.id),
                        isOffline: isOffline,
                        errorMessage: store.rowErrors[suggestion.id],
                        onApply: { Task { await store.apply(suggestion) } },
                        onDismiss: { Task { await store.dismiss(suggestion) } }
                    )
                }
            }
            .padding(16)
        }
    }

    private var summaryHeader: some View {
        let summary = RepricingStore.summary(store.suggestions)
        return HStack(spacing: 8) {
            ForEach(summary) { entry in
                HStack(spacing: 4) {
                    Image(systemName: entry.reason.systemImage)
                        .font(.caption2.weight(.bold))
                    Text("\(entry.count) \(entry.reason.label.lowercased())")
                        .font(.caption.weight(.semibold))
                }
                .foregroundStyle(entry.reason.tint)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(entry.reason.tint.opacity(0.12), in: Capsule())
            }
            Spacer(minLength: 0)
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No suggestions", systemImage: "checkmark.circle")
        } description: {
            Text("Your active listings are priced in line with the comps. Run a scan to check again.")
        } actions: {
            Button {
                Task { await store.scanThenReload() }
            } label: {
                if store.isScanning {
                    ProgressView()
                } else {
                    Text("Scan now")
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.brandNavy)
            .disabled(store.isScanning || isOffline)
        }
    }

    @ToolbarContentBuilder
    private var scanToolbarItem: some ToolbarContent {
        // US-672: automation rules (drop X% every N days, floor, auto-accept).
        ToolbarItem(placement: .topBarLeading) {
            NavigationLink {
                RepricingRulesView()
            } label: {
                Label("Automation", systemImage: "slider.horizontal.3")
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                AppRouter.haptic()
                Task { await store.scanThenReload() }
            } label: {
                if store.isScanning {
                    ProgressView()
                } else {
                    Label("Scan", systemImage: "arrow.clockwise")
                }
            }
            .disabled(store.isScanning || isOffline)
        }
    }

    @ViewBuilder
    private var bannerView: some View {
        if let banner = store.banner {
            Text(banner)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(Color.brandNavy, in: Capsule())
                .shadow(radius: 6, y: 2)
                .padding(.bottom, 16)
                .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}

/// One repricing suggestion: item · reason · current → suggested price ·
/// comp context · apply / dismiss.
private struct RepricingCard: View {
    let suggestion: RepricingSuggestion
    let isBusy: Bool
    /// US-981: when offline, Apply (and Dismiss) hit the edge and would just
    /// fail, so both are disabled until reconnect.
    var isOffline: Bool = false
    let errorMessage: String?
    let onApply: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(suggestion.title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(2)
                    if let sub = subtitle {
                        Text(sub).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                reasonBadge
            }

            priceRow

            if let message = suggestion.message, !message.isEmpty {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            compContext

            if let errorMessage {
                Text(errorMessage)
                    .font(.caption2)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            actions
        }
        .padding(16)
        .cardStyle(.flush)
    }

    private var reasonBadge: some View {
        HStack(spacing: 4) {
            Image(systemName: suggestion.reason.systemImage)
                .font(.caption2.weight(.bold))
            Text(suggestion.reason.label)
                .font(.caption2.weight(.semibold))
        }
        .foregroundStyle(suggestion.reason.tint)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(suggestion.reason.tint.opacity(0.14), in: Capsule())
    }

    private var priceRow: some View {
        HStack(spacing: 8) {
            Text(RepricingStore.centsDollars(suggestion.currentPriceCents))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .strikethrough()
            Image(systemName: "arrow.right")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(RepricingStore.centsDollars(suggestion.suggestedPriceCents))
                .font(.brandTitle2)
                .foregroundStyle(suggestion.reason.tint)
            if let pct = suggestion.deltaPct {
                Text(Self.signedPct(pct))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(suggestion.deltaCents >= 0 ? .brandEmerald : .brandAmber)
            }
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private var compContext: some View {
        if let median = suggestion.compMedianCents {
            let comps = suggestion.compCount.map { " · \($0) comps" } ?? ""
            let conf = suggestion.confidence.map { " · \(Int(($0 * 100).rounded()))% confidence" } ?? ""
            Text("Comp median \(RepricingStore.centsDollars(median))\(comps)\(conf)")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private var actions: some View {
        HStack(spacing: 10) {
            Button(action: onApply) {
                Group {
                    if isBusy {
                        ProgressView().controlSize(.small)
                    } else {
                        Text(errorMessage == nil ? "Apply" : "Retry")
                            .font(.subheadline.weight(.semibold))
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 9)
                .background(Color.brandNavy)
                .foregroundStyle(.white)
                .clipShape(Capsule())
            }
            .disabled(isBusy || isOffline)

            Button(action: onDismiss) {
                Text("Dismiss")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 9)
                    .foregroundStyle(.secondary)
                    .background(Color.secondary.opacity(0.12))
                    .clipShape(Capsule())
            }
            .disabled(isBusy || isOffline)
        }
    }

    private var subtitle: String? {
        var parts: [String] = []
        if let brand = suggestion.inventoryItems.brand, !brand.isEmpty { parts.append(brand) }
        if let grade = suggestion.inventoryItems.gradeValue {
            parts.append("Grade \(String(format: "%.1f", grade))")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private static func signedPct(_ pct: Double) -> String {
        let v = Int((pct * 100).rounded())
        return (v >= 0 ? "+" : "") + "\(v)%"
    }
}
