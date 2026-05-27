import Foundation

/// `GET /api/flipdesk/ebay/oauth/start` response shape. The web returns
/// the consent URL the SPA opens to send the user through eBay's OAuth
/// screens. EdgeAPI's shared decoder applies snake-to-camel conversion
/// so `consent_url` → `consentURL` automatically.
struct ConsentResponse: Decodable, Equatable {
    let consentURL: String
}

/// Row shape pulled from the `marketplace_connections` table. RLS-filtered
/// to the signed-in user's connections. We never decode token columns —
/// they're encrypted and only the edge service handles them.
struct RemoteMarketplaceConnection: Decodable, Equatable {
    let id: String
    let marketplace: String
    let accountHandle: String?
    let isActive: Bool
    let lastSyncedAt: String?
    let refreshError: String?
    let createdAt: String
    let updatedAt: String

    private enum CodingKeys: String, CodingKey {
        case id
        case marketplace
        case accountHandle = "account_handle"
        case isActive = "is_active"
        case lastSyncedAt = "last_synced_at"
        case refreshError = "refresh_error"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

/// Outcome surfaced by ``EbayConnectionService.connect()``. Mirrors the
/// `?ebay=` query param values the web's marketplaces page reads, plus a
/// success case that carries the new connection row.
enum EbayConnectResult: Equatable {
    case connected(RemoteMarketplaceConnection)
    case cancelled
    case stateExpired
    case error(message: String)

    /// Parse the callback URL's `ebay` query param into a discriminator
    /// when the web flow embeds one. Useful when the auth session lands
    /// on a URL like `com.gradethread.app://oauth/ebay?ebay=cancelled`.
    static func from(callbackURL: URL) -> EbayConnectResult? {
        guard let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        let items = components.queryItems ?? []
        let ebayValue = items.first { $0.name == "ebay" }?.value
        switch ebayValue {
        case "connected":
            return nil  // caller polls marketplace_connections to fetch the row
        case "cancelled":
            return .cancelled
        case "state_expired":
            return .stateExpired
        default:
            let errorValue = items.first { $0.name == "error" }?.value
            if let errorValue { return .error(message: errorValue) }
            return nil
        }
    }
}
