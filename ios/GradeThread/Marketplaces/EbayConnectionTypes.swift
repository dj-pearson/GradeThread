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

    /// US-1009: status conveyed to VoiceOver (color/icon alone isn't enough).
    /// Mirrors the visual state — selected radio, disconnected, reconnect-needed.
    var accessibilityStatus: String {
        if !isActive { return "Disconnected" }
        if isPrimary { return "Selected" }
        if refreshError != nil { return "Reconnect needed" }
        return "Not selected"
    }

    /// US-1009: combined VoiceOver label for an account row — name + handle (when
    /// a label is also set) + status — so the row reads fully without relying on
    /// the icon's color.
    var accessibilityRowLabel: String {
        var parts = [displayName]
        if label != nil, let handle = accountHandle, !handle.isEmpty {
            parts.append(handle)
        }
        parts.append(accessibilityStatus)
        return parts.joined(separator: ", ")
    }

    /// US-1009: confirmation title naming the account before a destructive
    /// disconnect (which stops sync + publishing for the store).
    var disconnectConfirmationTitle: String {
        "Disconnect \(displayName)?"
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
    ///
    /// US-699: on the SUCCESS path (`ebay=connected`) the nonce is now
    /// *required*, not merely checked-when-present. A callback that claims
    /// success but omits `client_state` is rejected (`.stateExpired`) so a
    /// forged `?ebay=connected` can't bypass the nonce on the client side. The
    /// server-side single-use `oauth_states` check (US-274) remains the real
    /// gate; this is defense-in-depth. Cancellation/error callbacks (which
    /// grant no capability) stay lenient about an absent state.
    static func from(callbackURL: URL, expectedState: String? = nil) -> EbayConnectResult? {
        guard let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        let items = components.queryItems ?? []
        let returnedState = items.first(where: { $0.name == "client_state" })?.value
        if let expectedState, let returnedState, returnedState != expectedState {
            return .stateExpired
        }
        let ebayValue = items.first { $0.name == "ebay" }?.value
        switch ebayValue {
        case "connected":
            // Success must carry the matching nonce when one was expected.
            if expectedState != nil, returnedState == nil {
                return .stateExpired
            }
            return nil  // caller polls marketplace_connections to fetch the row
        case "cancelled":
            return .cancelled
        case "state_expired":
            return .stateExpired
        default:
            // US-989: the callback's `error`/`ebay` codes are attacker-controllable
            // on the legacy custom-scheme path (any app/page can redirect to
            // `com.gradethread.app://oauth/ebay?error=<anything>`). NEVER surface
            // the raw value — map it through a small allowlist of known codes and
            // fall back to generic copy for everything else (or when no error code
            // is present at all but the edge bounced an unrecognized `ebay=` status).
            let errorValue = items.first { $0.name == "error" }?.value
            if let errorValue {
                return .error(message: sanitizedErrorMessage(forCode: errorValue))
            }
            if let ebayValue, !ebayValue.isEmpty {
                return .error(message: sanitizedErrorMessage(forCode: ebayValue))
            }
            return nil
        }
    }

    /// Generic copy shown for any unknown, oversized, or otherwise
    /// non-allowlisted callback error code. Deliberately leaks nothing about
    /// the raw value.
    static let genericErrorMessage = "eBay sign-in failed. Please try again."

    /// US-989: map a callback error code to user-facing copy. Only an allowlist
    /// of known OAuth/edge codes maps to specific copy; anything else — unknown
    /// code, or an oversized value (> 64 chars, i.e. someone trying to smuggle a
    /// message through the param) — collapses to ``genericErrorMessage`` so no
    /// raw, attacker-controllable string reaches the UI.
    static func sanitizedErrorMessage(forCode rawCode: String) -> String {
        // Reject oversized values outright before any matching.
        guard rawCode.count <= 64 else { return genericErrorMessage }
        switch rawCode.lowercased() {
        case "access_denied":
            return "eBay sign-in was cancelled."
        case "invalid_scope":
            return "eBay rejected the requested permissions. Please try again."
        case "invalid_state", "state_expired":
            return "Connection state expired — try connecting again."
        case "invalid_request", "unauthorized_client",
             "unsupported_response_type", "unsupported_grant_type":
            return "eBay couldn't complete the sign-in request. Please try again."
        case "exchange_failed":
            return "Couldn't finish connecting to eBay. Please try again."
        case "server_error", "temporarily_unavailable":
            return "eBay is temporarily unavailable. Please try again shortly."
        default:
            return genericErrorMessage
        }
    }
}
