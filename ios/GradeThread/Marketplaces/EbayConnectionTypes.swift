import Foundation

/// `GET /api/flipdesk/ebay/oauth/start` response shape. The web returns
/// the consent URL the SPA opens to send the user through eBay's OAuth
/// screens. EdgeAPI's shared decoder applies `.convertFromSnakeCase`, which
/// maps `consent_url` → `consentUrl` (NOT `consentURL` — the strategy
/// lower-cases acronyms). The property name must match that exactly or the
/// decode throws keyNotFound and eBay connect silently fails.
struct ConsentResponse: Decodable, Equatable {
    let consentUrl: String
}

/// Row shape pulled from the `marketplace_connections` table. RLS-filtered
/// to the signed-in user's connections. We never decode token columns —
/// they're encrypted and only the edge service handles them.
struct RemoteMarketplaceConnection: Decodable, Equatable, Identifiable {
    let id: String
    let marketplace: String
    let accountHandle: String?
    /// US-671: user-supplied label so multiple eBay stores are distinguishable.
    let label: String?
    /// US-671: the selected/active connection sync + publish operate against.
    let isPrimary: Bool
    let isActive: Bool
    let lastSyncedAt: String?
    let refreshError: String?
    let createdAt: String
    let updatedAt: String

    private enum CodingKeys: String, CodingKey {
        case id
        case marketplace
        case accountHandle = "account_handle"
        case label
        case isPrimary = "is_primary"
        case isActive = "is_active"
        case lastSyncedAt = "last_synced_at"
        case refreshError = "refresh_error"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        marketplace = try c.decode(String.self, forKey: .marketplace)
        accountHandle = try c.decodeIfPresent(String.self, forKey: .accountHandle)
        label = try c.decodeIfPresent(String.self, forKey: .label)
        // Tolerate rows from before the column existed.
        isPrimary = (try? c.decode(Bool.self, forKey: .isPrimary)) ?? false
        isActive = try c.decode(Bool.self, forKey: .isActive)
        lastSyncedAt = try c.decodeIfPresent(String.self, forKey: .lastSyncedAt)
        refreshError = try c.decodeIfPresent(String.self, forKey: .refreshError)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        updatedAt = try c.decode(String.self, forKey: .updatedAt)
    }

    /// Test/preview initializer.
    init(
        id: String,
        marketplace: String = "ebay",
        accountHandle: String? = nil,
        label: String? = nil,
        isPrimary: Bool = false,
        isActive: Bool = true,
        lastSyncedAt: String? = nil,
        refreshError: String? = nil,
        createdAt: String = "2026-01-01T00:00:00Z",
        updatedAt: String = "2026-01-01T00:00:00Z"
    ) {
        self.id = id
        self.marketplace = marketplace
        self.accountHandle = accountHandle
        self.label = label
        self.isPrimary = isPrimary
        self.isActive = isActive
        self.lastSyncedAt = lastSyncedAt
        self.refreshError = refreshError
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    /// Display name: label if set, else the eBay handle, else a fallback.
    var displayName: String {
        if let label, !label.isEmpty { return label }
        if let accountHandle, !accountHandle.isEmpty { return accountHandle }
        return "eBay account"
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
    ///
    /// US-660: when `expectedState` is provided and the callback carries a
    /// `client_state` that does NOT match, the callback is rejected
    /// (`.stateExpired`) — a forged callback can't claim a successful connect.
    /// A callback that omits `client_state` is treated leniently because the
    /// server-side single-use `oauth_states` check (US-274) already validated
    /// the real handshake; only a present-but-mismatched value is an attack
    /// signal here.
    static func from(callbackURL: URL, expectedState: String? = nil) -> EbayConnectResult? {
        guard let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        let items = components.queryItems ?? []
        if let expectedState,
           let returnedState = items.first(where: { $0.name == "client_state" })?.value,
           returnedState != expectedState {
            return .stateExpired
        }
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
