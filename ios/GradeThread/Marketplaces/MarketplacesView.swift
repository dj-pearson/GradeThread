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

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                headerCard
                if let userId = currentUserId() {
                    connectionCard(userId: userId)
                }
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
            }
        }
        .refreshable {
            if let userId = currentUserId() {
                await store.refresh(userId: userId)
            }
        }
        .sheet(isPresented: $showingSyncModal) {
            EbaySyncModal(
                store: syncStore,
                onDismiss: { syncStore.reset() }
            )
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
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text("Connected accounts")
                    .font(.headline)
                Text("Manage where your items sell.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(14)
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    // MARK: - eBay card

    @ViewBuilder
    private func connectionCard(userId: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("eBay")
                    .font(.title3.weight(.semibold))
                Spacer()
                statusPill
            }

            switch store.phase {
            case .loading:
                HStack {
                    ProgressView()
                    Text("Checking connection…")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
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
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
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
