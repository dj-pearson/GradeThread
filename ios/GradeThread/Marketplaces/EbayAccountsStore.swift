import Foundation
import Observation

/// Manages multiple connected eBay accounts (US-671): list, add, label,
/// select-active (primary), and disconnect individual accounts. Sync + publish
/// run against the selected (primary) connection — the edge token resolver
/// orders by is_primary, so selecting here changes what those operate against.
@MainActor
@Observable
final class EbayAccountsStore {
    enum Phase: Equatable {
        case loading
        case ready
        case failed(message: String)
    }

    private let service: EbayConnectionsProviding
    private let userId: String

    var phase: Phase = .loading
    private(set) var connections: [RemoteMarketplaceConnection] = []
    var isConnecting = false
    /// Surfaced on a failed mutation; the view shows it in an alert.
    var actionError: String?

    init(userId: String, service: EbayConnectionsProviding = EbayConnectionService()) {
        self.userId = userId
        self.service = service
    }

    /// Active connections (the ones the user can select/sync). Flagged/inactive
    /// rows still show in the list so the user can reconnect or remove them.
    var activeConnections: [RemoteMarketplaceConnection] { connections.filter(\.isActive) }

    var selected: RemoteMarketplaceConnection? {
        activeConnections.first(where: \.isPrimary) ?? activeConnections.first
    }

    func load() async {
        phase = .loading
        do {
            connections = try await service.fetchAllConnections(userId: userId)
            phase = .ready
        } catch {
            phase = .failed(message: error.localizedDescription)
        }
    }

    /// Adds another eBay account through the OAuth handshake, then reloads.
    func addAccount() async {
        guard !isConnecting else { return }
        isConnecting = true
        defer { isConnecting = false }
        do {
            _ = try await service.connect(userId: userId)
            await load()
        } catch let error as EbayConnectionService.ConnectionError {
            if case .userCancelled = error { return }  // no-op on cancel
            actionError = error.localizedDescription
        } catch {
            actionError = error.localizedDescription
        }
    }

    func rename(_ connection: RemoteMarketplaceConnection, to label: String) async {
        do {
            try await service.setLabel(connectionId: connection.id, userId: userId, label: label)
            await load()
        } catch {
            actionError = error.localizedDescription
        }
    }

    /// Sets the active connection sync/publish target.
    func makePrimary(_ connection: RemoteMarketplaceConnection) async {
        guard !connection.isPrimary else { return }
        // Optimistic flip so the radio updates immediately.
        connections = connections.map {
            var copy = $0
            copy = RemoteMarketplaceConnection(
                id: copy.id, marketplace: copy.marketplace, accountHandle: copy.accountHandle,
                label: copy.label, isPrimary: copy.id == connection.id, isActive: copy.isActive,
                lastSyncedAt: copy.lastSyncedAt, refreshError: copy.refreshError,
                createdAt: copy.createdAt, updatedAt: copy.updatedAt
            )
            return copy
        }
        do {
            try await service.setPrimary(connectionId: connection.id, userId: userId)
            await load()
        } catch {
            actionError = error.localizedDescription
            await load()
        }
    }

    func disconnect(_ connection: RemoteMarketplaceConnection) async {
        do {
            try await service.disconnect(connectionId: connection.id, userId: userId)
            await load()
        } catch {
            actionError = error.localizedDescription
        }
    }
}
