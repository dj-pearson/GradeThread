import AuthenticationServices
import Foundation
import Supabase
import UIKit

/// Drives the eBay OAuth handshake from the iOS side. Three-step flow:
///
///   1. `EdgeAPI.getJSON("/api/flipdesk/ebay/oauth/start")` → returns the
///      consent URL the user is sent through.
///   2. `ASWebAuthenticationSession` opens that URL in-app and watches
///      for a callback to our custom scheme `com.gradethread.app://...`.
///      iOS itself shows the browser chrome — the user never leaves the
///      app process.
///   3. After the session dismisses (success, cancel, or error), we
///      re-fetch `marketplace_connections` to confirm the row is active.
///      We don't rely on parsing the callback URL alone because the web's
///      callback handler may emit different redirect shapes depending on
///      eBay sandbox vs production.
///
/// US-661: on iOS 17.4+ the callback now lands on an https Universal Link
/// (`https://gradethread.com/app/oauth/ebay`) the app owns via
/// associated-domains, so `ASWebAuthenticationSession.Callback.https` completes
/// the in-app session deterministically and no other app can intercept the
/// callback by claiming a custom scheme. Below 17.4 we fall back to the legacy
/// `com.gradethread.app://oauth/ebay` scheme (the edge drops that to the web
/// dashboard, and we poll `marketplace_connections` to confirm). The OS-version
/// branching lives in ``OAuthWebSession``.
/// Operations the multi-account management surface (``EbayAccountsStore``)
/// needs, behind a protocol so the store is unit-testable with a fake (US-671).
@MainActor
protocol EbayConnectionsProviding {
    func fetchAllConnections(userId: String) async throws -> [RemoteMarketplaceConnection]
    func connect(userId: String) async throws -> RemoteMarketplaceConnection
    func disconnect(connectionId: String, userId: String) async throws
    func setLabel(connectionId: String, userId: String, label: String?) async throws
    func setPrimary(connectionId: String, userId: String) async throws
}

@MainActor
public final class EbayConnectionService: NSObject, EbayConnectionsProviding {

    public enum ConnectionError: LocalizedError, Equatable {
        case userCancelled
        case stateExpired
        case noActiveConnection
        case network(message: String)

        public var errorDescription: String? {
            switch self {
            case .userCancelled:
                return "eBay sign-in was cancelled."
            case .stateExpired:
                return "Connection state expired — try connecting again."
            case .noActiveConnection:
                return "Couldn't confirm the eBay connection. Try again or check Marketplaces on the web."
            case .network(let message):
                return message
            }
        }
    }

    /// Legacy custom-scheme callback — used only on iOS < 17.4.
    public static let callbackURL = URL(string: "com.gradethread.app://oauth/ebay")!
    public static let callbackURLScheme = "com.gradethread.app"

    /// US-661: https Universal Link the app claims (`applinks:gradethread.com`).
    /// The edge `/oauth/callback` bounces here with `?ebay=<status>` and the
    /// echoed `client_state`. Host + path must match an AASA component.
    public static let universalLinkHost = "gradethread.com"
    public static let universalLinkPath = "/app/oauth/ebay"
    /// Relative redirect_to sent to `/oauth/start`. Same-origin path the edge
    /// sanitizer allowlists (`/app`), resolved to the https Universal Link.
    public static let universalLinkRedirectPath = "/app/oauth/ebay"

    /// Whether this OS can use the Universal Link callback.
    static var supportsUniversalLinkCallback: Bool {
        if #available(iOS 17.4, *) { return true }
        return false
    }

    private let supabase: SupabaseClient

    nonisolated public init(supabase: SupabaseClient = SupabaseShared.client) {
        self.supabase = supabase
        super.init()
    }

    // MARK: - Public flow

    /// Runs the full connect handshake and resolves to the new row when
    /// successful. Throws on cancel, expired state, or network failure.
    func connect(userId: String) async throws -> RemoteMarketplaceConnection {
        // US-660: client-side CSRF nonce (mirrors the Apple Sign-In pattern).
        // The server already enforces single-use state via the oauth_states
        // table (US-274); this is defense-in-depth so a forged callback to our
        // URL scheme carrying a *different* state is rejected here too.
        let stateNonce = Self.generateStateNonce()
        let useUniversalLink = Self.supportsUniversalLinkCallback
        let redirectTo = useUniversalLink
            ? Self.universalLinkRedirectPath
            : Self.callbackURL.absoluteString
        let consent = try await fetchConsentURL(stateNonce: stateNonce, redirectTo: redirectTo)
        let callback = try await runAuthSession(url: consent, useUniversalLink: useUniversalLink)
        if let result = EbayConnectResult.from(callbackURL: callback, expectedState: stateNonce) {
            switch result {
            case .cancelled:    throw ConnectionError.userCancelled
            case .stateExpired: throw ConnectionError.stateExpired
            case .error(let message): throw ConnectionError.network(message: message)
            case .connected:    break  // fall through to row fetch
            }
        }
        // The token exchange happens server-side during the callback —
        // by the time ASWebAuthenticationSession returns, the row should
        // exist. We poll briefly (3 attempts × 600ms) to absorb any
        // small server-side write delay.
        for attempt in 0..<3 {
            if let row = try await fetchActiveConnection(userId: userId) {
                return row
            }
            if attempt < 2 {
                try? await Task.sleep(nanoseconds: 600_000_000)
            }
        }
        throw ConnectionError.noActiveConnection
    }

    /// Disconnects an eBay connection via the edge `POST /disconnect` (US-1507).
    ///
    /// The old path did a DIRECT supabase update with nil token fields — but
    /// supabase-swift's synthesized Encodable OMITS a nil optional, so only
    /// `is_active=false` was written and the encrypted access/refresh tokens
    /// LINGERED in the row at rest, and the eBay grant was never revoked upstream.
    /// The edge endpoint revokes the grant at eBay AND nulls the token columns;
    /// `connection_id` scopes it to the single tapped account (multi-account safe).
    public func disconnect(connectionId: String, userId: String) async throws {
        struct Body: Encodable { let connection_id: String }
        struct DisconnectResponse: Decodable { let ok: Bool }
        _ = userId  // authorization is the caller's session on the edge; kept for the protocol signature
        let _: DisconnectResponse = try await EdgeAPI.shared.postJSON(
            "/api/flipdesk/ebay/disconnect",
            body: Body(connection_id: connectionId)
        )
    }

    /// Fetches the user's current active eBay connection if one exists.
    /// Used by ``MarketplaceConnectionStore`` on appear and after
    /// connect/disconnect to refresh the UI state. US-671: prefers the
    /// selected (primary) connection so the summary card + sync target match.
    func fetchActiveConnection(userId: String) async throws -> RemoteMarketplaceConnection? {
        let rows: [RemoteMarketplaceConnection] = try await supabase
            .from("marketplace_connections")
            .select(Self.connectionColumns)
            .eq("user_id", value: userId)
            .eq("marketplace", value: "ebay")
            .eq("is_active", value: true)
            .order("is_primary", ascending: false)
            .order("updated_at", ascending: false)
            .limit(1)
            .execute()
            .value
        return rows.first
    }

    /// Fetches the most recent connection regardless of active state —
    /// surfaces a 'reconnect required' card when the refresh worker
    /// has flagged a stale grant.
    func fetchLatestConnection(userId: String) async throws -> RemoteMarketplaceConnection? {
        let rows: [RemoteMarketplaceConnection] = try await supabase
            .from("marketplace_connections")
            .select(Self.connectionColumns)
            .eq("user_id", value: userId)
            .eq("marketplace", value: "ebay")
            .order("created_at", ascending: false)
            .limit(1)
            .execute()
            .value
        return rows.first
    }

    static let connectionColumns =
        "id, marketplace, account_handle, label, is_primary, is_active, last_synced_at, refresh_error, created_at, updated_at"

    // MARK: - Multi-account (US-671)

    /// All eBay connections for the user (active + flagged), primary first.
    /// Backs the multi-account management surface.
    func fetchAllConnections(userId: String) async throws -> [RemoteMarketplaceConnection] {
        try await supabase
            .from("marketplace_connections")
            .select(Self.connectionColumns)
            .eq("user_id", value: userId)
            .eq("marketplace", value: "ebay")
            .order("is_primary", ascending: false)
            .order("created_at", ascending: false)
            .execute()
            .value
    }

    /// Renames a connection. RLS + the explicit user_id scope keep it to the
    /// caller's row (never update a multi-tenant row by id alone — CLAUDE.md US-268).
    func setLabel(connectionId: String, userId: String, label: String?) async throws {
        struct LabelUpdate: Encodable { let label: String? }
        let trimmed = label?.trimmingCharacters(in: .whitespacesAndNewlines)
        try await supabase
            .from("marketplace_connections")
            .update(LabelUpdate(label: (trimmed?.isEmpty ?? true) ? nil : trimmed))
            .eq("id", value: connectionId)
            .eq("user_id", value: userId)
            .execute()
    }

    /// Selects the active connection. Clears any existing primary first (so the
    /// one-primary partial-unique index holds), then sets this one — both scoped
    /// to the caller's rows.
    func setPrimary(connectionId: String, userId: String) async throws {
        struct PrimaryFlag: Encodable { let is_primary: Bool }
        try await supabase
            .from("marketplace_connections")
            .update(PrimaryFlag(is_primary: false))
            .eq("user_id", value: userId)
            .eq("marketplace", value: "ebay")
            .eq("is_primary", value: true)
            .execute()
        try await supabase
            .from("marketplace_connections")
            .update(PrimaryFlag(is_primary: true))
            .eq("id", value: connectionId)
            .eq("user_id", value: userId)
            .execute()
    }

    // MARK: - Internals

    /// Cryptographically-random URL-safe nonce for the OAuth `state` round-trip.
    /// US-1219: fail CLOSED on a CSPRNG failure — if `SecRandomCopyBytes` doesn't
    /// return `errSecSuccess` the buffer stays all-zeros and would emit a constant,
    /// predictable `state`, degrading the client-side CSRF defense to nothing.
    /// Mirrors `SignInWithAppleCoordinator.randomNonce`'s `precondition` rather
    /// than silently discarding the result.
    static func generateStateNonce() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let result = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        precondition(result == errSecSuccess, "SecRandomCopyBytes failed — refusing to emit a predictable OAuth state nonce")
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func fetchConsentURL(stateNonce: String, redirectTo: String) async throws -> URL {
        let response: ConsentResponse = try await EdgeAPI.shared.getJSON(
            "/api/flipdesk/ebay/oauth/start",
            query: [
                URLQueryItem(name: "redirect_to", value: redirectTo),
                // Round-tripped back on the callback so we can verify it.
                URLQueryItem(name: "client_state", value: stateNonce),
            ]
        )
        return try Self.validatedConsentURL(response.consentUrl)
    }

    /// US-989: hosts the eBay OAuth consent URL is allowed to point at. A
    /// server-returned consent URL on any other host is rejected so a
    /// compromised, buggy, or man-in-the-middled edge can't drive the in-app
    /// `ASWebAuthenticationSession` (which looks authenticated to the user) to
    /// an attacker-controlled page. Covers `ebay.com`, any subdomain
    /// (`signin.ebay.com`, `auth.ebay.com`, …) and the sandbox equivalents
    /// (`signin.sandbox.ebay.com` ends with `.ebay.com`).
    static func isAllowedConsentHost(_ host: String) -> Bool {
        let h = host.lowercased()
        return h == "ebay.com" || h.hasSuffix(".ebay.com")
    }

    /// US-989: parse + validate a server-returned consent URL string. A
    /// successful `URL(string:)` parse alone no longer gates opening the
    /// web-auth session — the URL must also be https and on the eBay host
    /// allowlist. Throws ``ConnectionError/network(message:)`` otherwise.
    static func validatedConsentURL(_ raw: String) throws -> URL {
        guard let url = URL(string: raw),
              url.scheme?.lowercased() == "https",
              let host = url.host,
              isAllowedConsentHost(host) else {
            throw ConnectionError.network(
                message: "Server returned an unexpected consent URL.")
        }
        return url
    }

    private func runAuthSession(url: URL, useUniversalLink: Bool) async throws -> URL {
        let callback: OAuthWebSession.Callback = useUniversalLink
            ? .universalLink(host: Self.universalLinkHost, path: Self.universalLinkPath)
            : .customScheme(Self.callbackURLScheme)
        do {
            // Non-ephemeral so the session shares Safari's cookie jar: a user
            // already signed into eBay gets a one-tap "Continue" instead of
            // re-entering credentials every connect. We deliberately DON'T use
            // the ephemeral isolation here (unlike our own app's auth) because
            // this is a third-party marketplace link the user explicitly wants
            // to keep connected — the smoother re-auth is worth more than the
            // isolation, and CSRF is already covered by the single-use `state`
            // nonce (server oauth_states table + client-side check above).
            return try await OAuthWebSession.run(
                url: url,
                callback: callback,
                prefersEphemeralWebBrowserSession: false,
                anchorProvider: self
            )
        } catch let error as OAuthWebSession.SessionError {
            switch error {
            case .cancelled:
                throw ConnectionError.userCancelled
            case .noCallback, .failed:
                throw ConnectionError.network(message: error.localizedDescription
                    ?? "eBay sign-in failed.")
            }
        }
    }
}

// MARK: - Presentation anchor

extension EbayConnectionService: ASWebAuthenticationPresentationContextProviding {
    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        WebAuthPresentationAnchor.resolve()
    }
}
