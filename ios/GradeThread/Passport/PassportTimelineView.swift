import SwiftUI

/// Native Garment Passport viewer (US-1115) — parity with the web trust surface
/// (`src/pages/passport.tsx`). Renders the public, PII-free, confidence-scored
/// provenance chain for a graded item, a Share affordance that produces the
/// public passport URL (mirroring the certificate ShareLink), and an
/// owner-facing ownership-claim handoff link the owner can hand to a buyer.
///
/// Presented from ``CertifiedGradeSection`` for a graded item. The chain itself
/// is fully pseudonymous — no PII is ever shown (the edge sanitizes it).
struct PassportTimelineView: View {
    let inventoryItemId: String
    /// Optional title for the header, when known by the caller.
    var itemTitle: String?

    @Environment(\.dismiss) private var dismiss
    @State private var model: PassportViewModel

    init(inventoryItemId: String, itemTitle: String? = nil) {
        self.inventoryItemId = inventoryItemId
        self.itemTitle = itemTitle
        _model = State(initialValue: PassportViewModel(inventoryItemId: inventoryItemId))
    }

    var body: some View {
        NavigationStack {
            Group {
                switch model.phase {
                case .loading:
                    loadingState
                case let .loaded(timeline):
                    loaded(timeline)
                case .empty:
                    emptyState
                case let .failed(message):
                    failedState(message)
                }
            }
            .navigationTitle("Garment Passport")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await model.load() }
            // FlipDesk feedback convention: transient success banner + error alert.
            .overlay(alignment: .top) { banner }
            .alert(
                "Couldn't create handoff link",
                isPresented: Binding(
                    get: { model.actionError != nil },
                    set: { if !$0 { model.actionError = nil } }
                )
            ) {
                Button("OK", role: .cancel) { model.actionError = nil }
            } message: {
                Text(model.actionError ?? "")
            }
        }
    }

    // MARK: - Phases

    // US-1200: shared skeleton instead of a bare centered spinner.
    private var loadingState: some View {
        VStack(alignment: .leading, spacing: 16) {
            SkeletonBlock().frame(height: 80)
            SkeletonBlock().frame(height: 110)
            SkeletonBlock().frame(height: 150)
            Spacer()
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color(uiColor: .systemGroupedBackground))
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No passport yet", systemImage: "doc.text.magnifyingglass")
        } description: {
            Text("This item doesn't have a Garment Passport yet. Get it certified to start its provenance chain.")
        }
    }

    private func failedState(_ message: String) -> some View {
        // US-1200: shared error component (consistent retry affordance).
        ErrorStateView(
            title: "Couldn't load passport",
            message: message,
            systemImage: "wifi.exclamationmark",
            retry: { await model.load() }
        )
    }

    // MARK: - Loaded

    private func loaded(_ timeline: PassportTimeline) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header(timeline)
                if let seller = timeline.originVerifiedSeller {
                    originSellerCard(seller)
                }
                chainStrengthCard(timeline)
                timelineSection(timeline)
                shareSection
                handoffSection
                disclaimer
            }
            .padding(20)
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }

    private func header(_ timeline: PassportTimeline) -> some View {
        let name = itemTitle?.isEmpty == false
            ? (itemTitle ?? "")
            : PassportFormat.garmentName(from: timeline.skuClass)
        let latestGraded = timeline.events.last { $0.eventType == "graded" }
        return HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text(name)
                    .font(.headline)
                    .lineLimit(2)
                Text("Pseudonymous, confidence-scored provenance — no personal data.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if !timeline.createdAt.isEmpty {
                    Text("First graded \(PassportFormat.longDate(timeline.createdAt))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            if let graded = latestGraded,
               let score = graded.payload.overallScore {
                VStack(alignment: .trailing, spacing: 2) {
                    Text(String(format: "%.1f", score))
                        .font(.title.weight(.bold))
                        .foregroundStyle(GradeScale.color(for: score))
                    if let tier = graded.payload.gradeTier {
                        Text(tier)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(.flush)
    }

    private func originSellerCard(_ seller: PassportVerifiedSeller) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.seal.fill")
                .foregroundStyle(Color.brandNavy)
            VStack(alignment: .leading, spacing: 2) {
                Text("Originally graded & sold by")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(seller.displayName ?? "@\(seller.handle)")
                    .font(.subheadline.weight(.semibold))
            }
            Spacer(minLength: 0)
            Text("Verified Seller")
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Color.brandNavy.opacity(0.12), in: Capsule())
                .foregroundStyle(Color.brandNavy)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(.flush)
    }

    private func chainStrengthCard(_ timeline: PassportTimeline) -> some View {
        let strength = PassportChainStrength(confidences: timeline.events.map { $0.confidence })
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Chain strength")
                    .font(.caption.weight(.semibold))
                    .textCase(.uppercase)
                    .foregroundStyle(.secondary)
                Spacer()
                Label(strength.label.rawValue, systemImage: "checkmark.shield.fill")
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(strengthColor(strength.label).opacity(0.15), in: Capsule())
                    .foregroundStyle(strengthColor(strength.label))
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.secondary.opacity(0.15))
                    Capsule()
                        .fill(Color.brandNavy)
                        .frame(width: max(4, geo.size.width * min(max(strength.score, 0), 1)))
                }
            }
            .frame(height: 7)
            Text(chainSummary(strength))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(.flush)
    }

    private func chainSummary(_ strength: PassportChainStrength) -> String {
        guard strength.probable > 0 else { return strength.summary }
        let linkWord = strength.probable == 1 ? "link is" : "links are"
        return "\(strength.summary) \(strength.probable) \(linkWord) a probable (inferred) match."
    }

    private func timelineSection(_ timeline: PassportTimeline) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Provenance timeline")
                .font(.caption.weight(.semibold))
                .textCase(.uppercase)
                .foregroundStyle(.secondary)
            if timeline.events.isEmpty {
                Text("No history recorded yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(timeline.events.enumerated()), id: \.offset) { index, event in
                    PassportEventRow(event: event, isLast: index == timeline.events.count - 1)
                }
            }
        }
    }

    // US-1203: @ViewBuilder so it contributes nothing (no empty VStack adding a
    // stray gap into the parent's spacing) when there's no share URL.
    @ViewBuilder
    private var shareSection: some View {
        if let url = model.shareURL {
            VStack(spacing: 10) {
                ShareLink(item: url) {
                    Label("Share passport", systemImage: "square.and.arrow.up")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Color.brandNavy)
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
                }
                Text("Share this garment's public, pseudonymous history — buyers can verify provenance before they buy.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
    }

    @ViewBuilder
    private var handoffSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Hand off ownership")
                .font(.caption.weight(.semibold))
                .textCase(.uppercase)
                .foregroundStyle(.secondary)
            Text("Generate a single-use claim link to give the buyer. When they open it, ownership of this passport transfers to them and the chain continues.")
                .font(.caption)
                .foregroundStyle(.secondary)

            if let handoff = model.handoff {
                ShareLink(item: handoff.url) {
                    Label("Share claim link", systemImage: "person.badge.shield.checkmark")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.brandNavy)
                Button {
                    AppRouter.haptic()
                    SecurePasteboard.copy(handoff.url.absoluteString)
                    model.actionBanner = "Claim link copied"
                } label: {
                    Label("Copy claim link", systemImage: "doc.on.doc")
                        .font(.subheadline.weight(.medium))
                }
            } else {
                Button {
                    AppRouter.haptic()
                    Task { await model.mintHandoffLink() }
                } label: {
                    HStack(spacing: 6) {
                        if model.minting {
                            ProgressView().tint(.white)
                        } else {
                            Image(systemName: "person.badge.shield.checkmark")
                        }
                        Text(model.minting ? "Creating link…" : "Create claim link")
                            .font(.subheadline.weight(.semibold))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(Color.brandNavy)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(model.minting)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(.flush)
    }

    private var disclaimer: some View {
        Text("Each entry is labeled with how certain its link in the chain is. Participants are shown as pseudonymous labels only — GradeThread never exposes personal information on a passport.")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.brandAmber.opacity(0.12), in: RoundedRectangle(cornerRadius: CornerRadius.control))
    }

    // MARK: - Banner

    @ViewBuilder
    private var banner: some View {
        if let text = model.actionBanner {
            Text(text)
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(Color.brandNavy, in: Capsule())
                .foregroundStyle(.white)
                .padding(.top, 8)
                .shadow(radius: 6, y: 2)
                .transition(.move(edge: .top).combined(with: .opacity))
                .task(id: text) {
                    try? await Task.sleep(nanoseconds: 2_500_000_000)
                    model.actionBanner = nil
                }
        }
    }

    private func strengthColor(_ label: PassportChainStrength.Label) -> Color {
        switch label {
        case .strong: return .brandEmerald
        case .moderate: return .brandAmber
        case .emerging, .none: return .secondary
        }
    }
}

/// One row of the vertical provenance timeline.
private struct PassportEventRow: View {
    let event: PassportEvent
    let isLast: Bool

    var body: some View {
        let presentation = event.presentation
        let level = PassportConfidence.level(of: event.confidence)
        return HStack(alignment: .top, spacing: 12) {
            // Node marker + connector line.
            VStack(spacing: 0) {
                ZStack {
                    Circle().fill(Color.brandNavy)
                    Image(systemName: presentation.symbol)
                        .font(.footnote)
                        .foregroundStyle(.white)
                }
                .frame(width: 34, height: 34)
                if !isLast {
                    Rectangle()
                        .fill(Color.secondary.opacity(0.25))
                        .frame(width: 1)
                        .frame(maxHeight: .infinity)
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(presentation.label)
                        .font(.subheadline.weight(.semibold))
                    Spacer(minLength: 8)
                    confidenceBadge(level)
                }

                // Grade detail (graded events).
                if let score = event.payload.overallScore, let tier = event.payload.gradeTier {
                    Text("\(String(format: "%.1f", score))/10 — \(tier)")
                        .font(.caption)
                        .foregroundStyle(GradeScale.color(for: score))
                }

                HStack(spacing: 10) {
                    if !event.createdAt.isEmpty {
                        Label(PassportFormat.longDate(event.createdAt), systemImage: "calendar")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    if let revealed = event.actorRevealed {
                        Label(revealed.displayName ?? "@\(revealed.handle)", systemImage: "checkmark.seal")
                            .font(.caption2)
                            .foregroundStyle(Color.brandNavy)
                    } else if let actor = event.actor {
                        Text(actor)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.bottom, isLast ? 0 : 14)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(presentation.label), \(level.label)")
    }

    private func confidenceBadge(_ level: PassportConfidence) -> some View {
        Label(level.label, systemImage: confidenceSymbol(level))
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(confidenceColor(level).opacity(0.15), in: Capsule())
            .foregroundStyle(confidenceColor(level))
    }

    private func confidenceColor(_ level: PassportConfidence) -> Color {
        switch level {
        case .deterministic: return .brandEmerald
        case .probable: return .brandAmber
        case .unknown: return .secondary
        }
    }

    /// Distinct glyph per level so certainty reads by shape, not color alone.
    private func confidenceSymbol(_ level: PassportConfidence) -> String {
        switch level {
        case .deterministic: return "checkmark.shield.fill"
        case .probable: return "questionmark.shield.fill"
        case .unknown: return "shield.slash.fill"
        }
    }
}

/// Drives ``PassportTimelineView``: resolves the item's passport, loads the
/// chain, and mints the owner claim-handoff link. Follows the FlipDesk store
/// feedback convention (`actionError` alert + `actionBanner` capsule).
@MainActor
@Observable
final class PassportViewModel {
    enum Phase: Equatable {
        case loading
        case loaded(PassportTimeline)
        case empty
        case failed(String)
    }

    private(set) var phase: Phase = .loading
    private(set) var ref: PassportService.Ref?
    private(set) var handoff: PassportHandoff?
    private(set) var minting = false
    var actionError: String?
    var actionBanner: String?

    let inventoryItemId: String

    init(inventoryItemId: String) {
        self.inventoryItemId = inventoryItemId
    }

    /// Public passport share URL (the web trust page).
    var shareURL: URL? {
        guard let slug = ref?.slug else { return nil }
        return URL(string: "\(CertificateLink.siteOrigin.absoluteString)/passport/\(slug)")
    }

    func load() async {
        phase = .loading
        do {
            guard let resolved = try await PassportService.resolve(inventoryItemId: inventoryItemId) else {
                phase = .empty
                return
            }
            ref = resolved
            let timeline = try await PassportService.fetchTimeline(slug: resolved.slug)
            phase = .loaded(timeline)
        } catch {
            phase = .failed(friendly(error))
        }
    }

    func mintHandoffLink() async {
        guard let garmentId = ref?.garmentId, !minting else { return }
        minting = true
        defer { minting = false }
        do {
            handoff = try await PassportService.mintHandoffLink(garmentId: garmentId)
            actionBanner = "Claim link ready to share"
            HapticFeedback.success()
        } catch {
            actionError = friendly(error)
            HapticFeedback.error()
        }
    }

    private func friendly(_ error: Error) -> String {
        (error as? EdgeAPIError)?.errorDescription
            ?? FriendlyErrorCopy.actionMessage(for: error, fallback: "Something went wrong. Please try again.")
    }
}
