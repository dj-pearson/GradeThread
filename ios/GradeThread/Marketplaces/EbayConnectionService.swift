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
/// On iOS 17.4+ this could move to `ASWebAuthenticationSession.Callback.https`
/// with a Universal Link target. That's a polish pass — bumping the
/// deployment target + provisioning the AASA file at gradethread.com.
@MainActor
public final class EbayConnectionService: NSObject {

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

    /// Callback path under the registered custom URL scheme. Must match
    /// what the edge `/oauth/callback` handler eventually redirects to.
    public static let callbackURL = URL(string: "com.gradethread.app://oauth/ebay")!
    public static let callbackURLScheme = "com.gradethread.app"

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
        let consent = try await fetchConsentURL(stateNonce: stateNonce)
        let callback = try await runAuthSession(url: consent)
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

    /// Disconnects via direct supabase update — sets is_active=false and
    /// scrubs the encrypted token columns. The server-side cron + refresh
    /// worker will skip the row going forward.
    public func disconnect(connectionId: String, userId: String) async throws {
        struct Disconnect: Encodable {
            let is_active: Bool
            let access_token_encrypted: String?
            let refresh_token_encrypted: String?
        }
        try await supabase
            .from("marketplace_connections")
            .update(Disconnect(
                is_active: false,
                access_token_encrypted: nil,
                refresh_token_encrypted: nil
            ))
            .eq("id", value: connectionId)
            // US-660 / explicit-scoping rule: never update a row by id alone on
            // a multi-tenant table — pin it to the caller's user_id too.
            .eq("user_id", value: userId)
            .execute()
    }

    /// Fetches the user's current active eBay connection if one exists.
    /// Used by ``MarketplaceConnectionStore`` on appear and after
    /// connect/disconnect to refresh the UI state.
    func fetchActiveConnection(userId: String) async throws -> RemoteMarketplaceConnection? {
        let rows: [RemoteMarketplaceConnection] = try await supabase
            .from("marketplace_connections")
            .select("id, marketplace, account_handle, is_active, last_synced_at, refresh_error, created_at, updated_at")
            .eq("user_id", value: userId)
            .eq("marketplace", value: "ebay")
            .eq("is_active", value: true)
            .order("created_at", ascending: false)
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
            .select("id, marketplace, account_handle, is_active, last_synced_at, refresh_error, created_at, updated_at")
            .eq("user_id", value: userId)
            .eq("marketplace", value: "ebay")
            .order("created_at", ascending: false)
            .limit(1)
            .execute()
            .value
        return rows.first
    }

    // MARK: - Internals

    /// Cryptographically-random URL-safe nonce for the OAuth `state` round-trip.
    static func generateStateNonce() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func fetchConsentURL(stateNonce: String) async throws -> URL {
        let response: ConsentResponse = try await EdgeAPI.shared.getJSON(
            "/api/flipdesk/ebay/oauth/start",
            query: [
                URLQueryItem(name: "redirect_to", value: Self.callbackURL.absoluteString),
                // Round-tripped back on the callback so we can verify it.
                URLQueryItem(name: "client_state", value: stateNonce),
            ]
        )
        guard let url = URL(string: response.consentUrl) else {
            throw ConnectionError.network(message: "Server returned an invalid consent URL.")
        }
        return url
    }

    private func runAuthSession(url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<URL, Error>) in
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: Self.callbackURLScheme
            ) { callbackURL, error in
                if let error {
                    let nsError = error as NSError
                    if nsError.domain == ASWebAuthenticationSessionErrorDomain,
                       nsError.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                        cont.resume(throwing: ConnectionError.userCancelled)
                    } else {
                        cont.resume(throwing: ConnectionError.network(message: error.localizedDescription))
                    }
                    return
                }
                guard let callbackURL else {
                    cont.resume(throwing: ConnectionError.network(message: "No callback URL received."))
                    return
                }
                cont.resume(returning: callbackURL)
            }
            session.presentationContextProvider = self
            // US-660: isolate the web session — no shared Safari cookie jar, so
            // another app can't ride an existing eBay login to drive a silent
            // "connected" state. Costs the user an explicit eBay sign-in.
            session.prefersEphemeralWebBrowserSession = true
            session.start()
        }
    }
}

// MARK: - Presentation anchor

extension EbayConnectionService: ASWebAuthenticationPresentationContextProviding {
    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        if let window = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .flatMap(\.windows)
            .first(where: { $0.isKeyWindow }) {
            return window
        }
        return ASPresentationAnchor()
    }
}
