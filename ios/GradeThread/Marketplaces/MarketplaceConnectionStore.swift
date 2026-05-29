import Foundation
import Observation

/// State machine for the eBay connection card. Loaded on appear,
/// refreshed after connect/disconnect.
@MainActor
@Observable
public final class MarketplaceConnectionStore {
    enum Phase: Equatable {
        case loading
        case disconnected
        case connected(RemoteMarketplaceConnection)
        case reconnectRequired(RemoteMarketplaceConnection, message: String)
        case failed(message: String)
    }

    var phase: Phase = .loading
    public var isConnecting: Bool = false

    private let service: EbayConnectionService

    public init(service: EbayConnectionService = EbayConnectionService()) {
        self.service = service
    }

    // MARK: - Lifecycle

    public func refresh(userId: String) async {
        do {
            if let active = try await service.fetchActiveConnection(userId: userId) {
                phase = .connected(active)
                return
            }
            // No active connection — check if there's a stale one with a
            // refresh error so we can surface the 'reconnect required'
            // card per US-183's "Reconnect" path.
            if let latest = try await service.fetchLatestConnection(userId: userId),
               let error = latest.refreshError, !error.isEmpty {
                phase = .reconnectRequired(latest, message: error)
            } else {
                phase = .disconnected
            }
        } catch {
            phase = .failed(message: error.localizedDescription)
        }
    }

    public func connect(userId: String) async {
        guard !isConnecting else { return }
        isConnecting = true
        defer { isConnecting = false }

        do {
            let connection = try await service.connect(userId: userId)
            phase = .connected(connection)
        } catch let error as EbayConnectionService.ConnectionError {
            switch error {
            case .userCancelled:
                // No state change — leave the card where it was. The
                // calling view can surface a toast if it wants to.
                break
            default:
                phase = .failed(message: error.localizedDescription)
            }
        } catch {
            phase = .failed(message: error.localizedDescription)
        }
    }

    public func disconnect(userId: String) async {
        guard case let .connected(conn) = phase else { return }
        phase = .loading
        do {
            try await service.disconnect(connectionId: conn.id)
            phase = .disconnected
        } catch {
            // Failed disconnect — restore the previous state so the
            // user can retry.
            phase = .connected(conn)
        }
    }
}
