import SwiftUI

/// Marketplaces tab. Today: just the eBay connection card. Future
/// platforms (Poshmark / Mercari / Depop) get their own cards alongside
/// when US-149 lands.
struct MarketplacesView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(AuthStore.self) private var authStore
    @State private var store = MarketplaceConnectionStore()

    // US-184 sync
    @State private var syncStore = EbaySyncStore()
    @State private var showingSyncModal = false

    // US-186 reconciliation count badge — refreshed alongside connection
    // state so the link only shows up when there's actually orphan work.
    @State private var orphanCount: Int = 0
    /// US-645: track whether the last orphan-count query *failed* so a network
    /// error doesn't masquerade as "all reconciled" (count silently 0) and make
    /// the reconciliation card vanish.
    @State private var orphanCheckFailed = false

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                headerCard
                if let userId = currentUserId() {
                    connectionCard(userId: userId)
                    // US-671: manage multiple connected eBay stores.
                    if case .connected = store.phase {
                        ebayAccountsCard(userId: userId)
                        // US-673: best offers + buyer messages.
                        negotiationCard
                        // US-1043/1049: returns, cancellations, payment disputes.
                        postSaleCard
                    }
                    if orphanCheckFailed {
                        reconciliationErrorCard(userId: userId)
                    } else if orphanCount > 0 {
                        reconciliationCard
                    }
                    // US-289: photo-dump → reconcile-session intake.
                    reconcileIntakeCard(userId: userId)
                }
                // US-675: durable home for AutoLister-generated drafts + bulk edit.
                draftsCard
                // US-668: phased multi-channel surface — eBay is live above;
                // the rest are surfaced as "coming soon" so the app reflects the
                // real multi-marketplace roadmap.
                comingSoonChannelsSection
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .background(Color(uiColor: .systemGroupedBackground).ignoresSafeArea())
        .navigationTitle("Marketplaces")
        .navigationBarTitleDisplayMode(.large)
        .task {
            if let userId = currentUserId() {
                await store.refresh(userId: userId)
                await refreshOrphanCount(userId: userId)
            }
        }
        .refreshable {
            if let userId = currentUserId() {
                await store.refresh(userId: userId)
                await refreshOrphanCount(userId: userId)
            }
        }
        .sheet(isPresented: $showingSyncModal, onDismiss: { syncStore.reset() }) {
            EbaySyncModal(
                store: syncStore,
                onDismiss: { syncStore.reset() }
            )
        }
    }

    // US-668 / US-718: phased channel abstraction. Each channel carries its REAL
    // capability tier (mirrors web MARKETPLACE_TIER) so the app never advertises a
    // channel above what actually ships. Adding a second *live in-app* channel
    // means adding a `.api` connection card here; the rest of the surface
    // (and cross-listing entry points) iterate over this list.
    private enum ChannelTier {
        case api          // live API connector (eBay, Shopify) — managed on the web dashboard
        case apiPending   // connector built, awaiting platform approval (Depop)
        case extensionKit // listed via the GradeThread Lister browser extension (desktop)
        case comingSoon   // no integration yet

        var badge: String {
            switch self {
            case .api: return "Live · manage on web"
            case .apiPending: return "Coming soon"
            case .extensionKit: return "Browser extension"
            case .comingSoon: return "Coming soon"
            }
        }
    }

    private struct MarketplaceChannel: Identifiable {
        let id: String
        let label: String
        let systemImage: String
        let tier: ChannelTier
    }

    private static let phasedChannels: [MarketplaceChannel] = [
        .init(id: "shopify", label: "Shopify", systemImage: "cart", tier: .api),
        .init(id: "poshmark", label: "Poshmark", systemImage: "bag", tier: .extensionKit),
        .init(id: "mercari", label: "Mercari", systemImage: "shippingbox", tier: .extensionKit),
        .init(id: "grailed", label: "Grailed", systemImage: "tag", tier: .extensionKit),
        .init(id: "depop", label: "Depop", systemImage: "tshirt", tier: .apiPending),
        .init(id: "whatnot", label: "Whatnot", systemImage: "video", tier: .comingSoon),
    ]

    private var comingSoonChannelsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("More channels")
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, alignment: .leading)
            Text("eBay + Shopify connect via API on the web dashboard. Poshmark, Mercari & Grailed cross-list from your own logged-in tab with the GradeThread Lister browser extension.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            ForEach(Self.phasedChannels) { channel in
                HStack(spacing: 12) {
                    Image(systemName: channel.systemImage)
                        .font(.system(size: 18))
                        .foregroundStyle(.secondary)
                        .frame(width: 36, height: 36)
                        .background(Color.secondary.opacity(0.12))
                        .clipShape(RoundedRectangle(cornerRadius: CornerRadius.chip, style: .continuous))
                    Text(channel.label)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                    Spacer()
                    Text(channel.tier.badge)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Color.brandNavy)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Color.brandNavy.opacity(0.12))
                        .clipShape(Capsule())
                }
                .padding(12)
                .cardStyle(.flush)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(channel.label), \(channel.tier.badge)")
            }
        }
    }

    // US-671: multiple eBay account management entry point.
    private func ebayAccountsCard(userId: String) -> some View {
        NavigationLink {
            EbayAccountsView(userId: userId)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "person.2.crop.square.stack")
                    .font(.title3)
                    .foregroundStyle(Color.brandNavy)
                VStack(alignment: .leading, spacing: 2) {
                    Text("eBay accounts")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("Connect, label, and switch between multiple eBay stores")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(16)
            .cardStyle(.flush)
        }
        .buttonStyle(.plain)
    }

    // US-289: photo-dump → reconcile-session intake. Scoped to the active
    // workspace owner (US-670).
    private func reconcileIntakeCard(userId: String) -> some View {
        NavigationLink {
            ReconcileIntakeView(ownerId: WorkspaceScope.tenantOwnerId(selfId: userId))
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "rectangle.stack.badge.plus")
                    .font(.title3)
                    .foregroundStyle(Color.brandNavy)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Reconcile photo dump")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("Send a batch of photos to a reconcile session to group into items on the web board")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(16)
            .cardStyle(.flush)
        }
        .buttonStyle(.plain)
    }

    // US-673: best offers + buyer messages entry point.
    private var negotiationCard: some View {
        NavigationLink {
            NegotiationInboxView()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "bubble.left.and.exclamationmark.bubble.right")
                    .font(.title3)
                    .foregroundStyle(Color.brandNavy)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Offers & messages")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("Review best offers and reply to buyers without leaving the app")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(16)
            .cardStyle(.flush)
        }
        .buttonStyle(.plain)
    }

    // US-1043/1049: returns, cancellations & payment disputes entry point.
    private var postSaleCard: some View {
        NavigationLink {
            PostSaleView()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "shield.lefthalf.filled")
                    .font(.title3)
                    .foregroundStyle(Color.brandNavy)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Returns & disputes")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("Handle returns, cancellations, and payment disputes before their deadlines")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(16)
            .cardStyle(.flush)
        }
        .buttonStyle(.plain)
    }

    // US-675: AutoLister drafts library entry point.
    private var draftsCard: some View {
        NavigationLink {
            DraftsLibraryView()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "square.stack.3d.up.fill")
                    .font(.title3)
                    .foregroundStyle(Color.brandNavy)
                VStack(alignment: .leading, spacing: 2) {
                    Text("AutoLister drafts")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("Review + bulk-edit generated listings before publishing")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(16)
            .cardStyle(.flush)
        }
        .buttonStyle(.plain)
    }

    private var reconciliationCard: some View {
        NavigationLink {
            ReconciliationView()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "arrow.left.arrow.right")
                    .font(.system(size: 20))
                    .foregroundStyle(Color.brandAmber)
                    .frame(width: 40, height: 40)
                    .background(Color.brandAmber.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Reconciliation")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("\(orphanCount) unmatched eBay listing\(orphanCount == 1 ? "" : "s")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(16)
            .cardStyle(.flush)
        }
        .buttonStyle(.plain)
    }

    /// US-645: a failed check shows a distinct "couldn't check — tap to retry"
    /// card instead of silently hiding reconciliation as if everything matched.
    private func reconciliationErrorCard(userId: String) -> some View {
        Button {
            Task { await refreshOrphanCount(userId: userId) }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "exclamationmark.arrow.triangle.2.circlepath")
                    .font(.system(size: 20))
                    .foregroundStyle(Color.brandAmber)
                    .frame(width: 40, height: 40)
                    .background(Color.brandAmber.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Couldn't check reconciliation")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("Tap to retry")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "arrow.clockwise")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(16)
            .cardStyle(.flush)
        }
        .buttonStyle(.plain)
    }

    private func refreshOrphanCount(userId: String) async {
        // Lightweight count query — we only need the badge number here;
        // the full list loads when the user opens ReconciliationView.
        struct Row: Decodable { let id: String }
        do {
            let rows: [Row] = try await SupabaseShared.client
                .from("flipdesk_ebay_listings")
                .select("id")
                .eq("user_id", value: userId)
                .eq("match_status", value: "unmatched")
                .execute()
                .value
            orphanCount = rows.count
            orphanCheckFailed = false
        } catch {
            // Don't zero the count — keep the last known value and flag the
            // failure so the UI can offer a retry rather than implying zero.
            orphanCheckFailed = true
        }
    }

    // MARK: - Header

    private var headerCard: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: "antenna.radiowaves.left.and.right")
                .font(.system(size: 24))
                .foregroundStyle(Color.brandNavy)
                .frame(width: 48, height: 48)
                .background(Color.brandNavy.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text("Connected accounts")
                    .font(.brandHeadline)
                Text("Manage where your items sell.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(16)
        .cardStyle(.flush)
    }

    // MARK: - eBay card

    @ViewBuilder
    private func connectionCard(userId: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("eBay")
                    .font(.brandTitle2)
                Spacer()
                statusPill
            }

            switch store.phase {
            case .loading:
                // US-692: skeleton the connection panel instead of a bare spinner.
                VStack(alignment: .leading, spacing: 10) {
                    SkeletonLine(widthFraction: 0.5, height: 14)
                    SkeletonLine(widthFraction: 0.7, height: 12)
                    SkeletonBlock(cornerRadius: CornerRadius.control).frame(height: 38)
                }
                .accessibilityLabel("Checking connection")
            case .disconnected:
                disconnectedBody(userId: userId)
            case .connected(let conn):
                connectedBody(connection: conn, userId: userId)
            case .reconnectRequired(let conn, let message):
                reconnectBody(connection: conn, message: message, userId: userId)
            case .failed(let message):
                failedBody(message: message, userId: userId)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .cardStyle(.flush)
    }

    // MARK: - Card bodies

    private func disconnectedBody(userId: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Connect your eBay seller account to push listings, sync orders, and reconcile payouts from this app.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            connectButton(userId: userId, label: "Connect eBay account")
        }
    }

    private func connectedBody(
        connection: RemoteMarketplaceConnection,
        userId: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let handle = connection.accountHandle {
                Label("Signed in as \(handle)", systemImage: "person.crop.circle.badge.checkmark")
                    .font(.subheadline)
            }
            if let last = connection.lastSyncedAt {
                Label("Last sync \(humanRelative(last))", systemImage: "clock")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                Label("Hasn't synced yet — first pull starts soon.", systemImage: "clock")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 10) {
                Button {
                    AppRouter.haptic()
                    Task { await runSync(userId: userId) }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.triangle.2.circlepath")
                        Text("Sync now")
                    }
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color.brandNavy)
                    .foregroundStyle(.white)
                    .clipShape(Capsule())
                }

                connectButton(userId: userId, label: "Reconnect")
                Button(role: .destructive) {
                    Task { await store.disconnect(userId: userId) }
                } label: {
                    Text("Disconnect")
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(Color.brandRed.opacity(0.1))
                        .foregroundStyle(Color.brandRed)
                        .clipShape(Capsule())
                }
            }
            .padding(.top, 4)
        }
    }

    private func runSync(userId: String) async {
        // Show the modal up front so the rotating-stage UI starts
        // before the network call returns.
        syncStore.beginSync()
        showingSyncModal = true

        let service = EbaySyncService(container: modelContext.container)
        let baseline = await service.snapshot(userId: userId)
        let completion = await service.sync(userId: userId, baseline: baseline)
        syncStore.apply(completion)
        // US-195: feedback that mirrors the completion outcome.
        switch completion {
        case .completed:           HapticFeedback.success()
        case .timedOut:            HapticFeedback.warning()
        case .connectionFlagged,
             .failed:              HapticFeedback.error()
        }

        // Refresh the connection card so the "last synced" line catches up.
        await store.refresh(userId: userId)
    }

    private func reconnectBody(
        connection: RemoteMarketplaceConnection,
        message: String,
        userId: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(
                "eBay flagged this connection — token refresh failed.",
                systemImage: "exclamationmark.triangle.fill"
            )
            .foregroundStyle(.orange)
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
            connectButton(userId: userId, label: "Reconnect eBay")
        }
    }

    private func failedBody(message: String, userId: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(message, systemImage: "exclamationmark.triangle")
                .font(.subheadline)
                .foregroundStyle(.red)
            connectButton(userId: userId, label: "Try again")
        }
    }

    // MARK: - Reusable bits

    private func connectButton(userId: String, label: String) -> some View {
        Button {
            AppRouter.haptic()
            Task { await store.connect(userId: userId) }
        } label: {
            HStack(spacing: 6) {
                if store.isConnecting { ProgressView().tint(.white) }
                Text(label).font(.subheadline.weight(.semibold))
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Color.brandNavy)
            .foregroundStyle(.white)
            .clipShape(Capsule())
        }
        .disabled(store.isConnecting)
    }

    private var statusPill: some View {
        Group {
            switch store.phase {
            case .connected:
                pill(text: "Connected", color: .green)
            case .reconnectRequired:
                pill(text: "Reconnect required", color: .orange)
            case .disconnected:
                pill(text: "Setup required", color: .secondary)
            case .loading, .failed:
                pill(text: "—", color: .secondary)
            }
        }
    }

    private func pill(text: String, color: Color) -> some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
    }

    private func humanRelative(_ iso: String) -> String {
        let isoFull = ISO8601DateFormatter()
        isoFull.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let isoPlain = ISO8601DateFormatter()
        guard let date = isoFull.date(from: iso) ?? isoPlain.date(from: iso) else {
            return "recently"
        }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: .now)
    }

    private func currentUserId() -> String? {
        if case let .signedIn(user) = authStore.phase {
            return user.id.uuidString
        }
        return nil
    }
}
