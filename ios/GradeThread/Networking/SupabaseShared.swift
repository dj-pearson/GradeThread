import Foundation
import Supabase

/// Single shared `SupabaseClient` instance configured from ``AppConfig``.
///
/// Exposed as a namespace rather than a class so call sites read naturally:
///
/// ```swift
/// try await SupabaseShared.client.auth.signIn(email: email, password: password)
/// let items = try await SupabaseShared.client
///     .from("inventory_items")
///     .select()
///     .eq("user_id", value: userId)
///     .execute()
///     .value
/// ```
///
/// Auth, database (PostgREST), and storage handles are reached through this
/// single client per supabase-swift's design.
public enum SupabaseShared {
    /// Legacy custom-scheme OAuth redirect (matched by ``Info.plist``'s
    /// `CFBundleURLTypes`). Used only on iOS < 17.4. A custom scheme is
    /// claimable by any installed app, so US-661 moves the sensitive callbacks
    /// to a Universal Link on 17.4+.
    public static let customSchemeRedirectURL = URL(string: "com.gradethread.app://auth-callback")!

    /// US-661: https Universal Link the app owns via associated-domains
    /// (`applinks:gradethread.com`, AASA path `/app/auth-callback`). Bound to
    /// our Apple Team ID, so no other app can intercept the auth callback. Must
    /// also be present in GoTrue's `additional_redirect_urls` (supabase/config.toml).
    public static let universalLinkRedirectURL = URL(string: "https://gradethread.com/app/auth-callback")!

    /// The redirect target for the current OS — Universal Link on 17.4+,
    /// custom scheme below.
    public static var redirectURL: URL {
        if #available(iOS 17.4, *) { return universalLinkRedirectURL }
        return customSchemeRedirectURL
    }

    /// Bounded session for ALL Supabase SDK traffic (auth + PostgREST). The SDK
    /// defaults to `URLSession.shared` (60s request timeout); on a stalled
    /// connection that hangs any `load()` that awaits a `SupabaseShared.client`
    /// fetch behind its spinner for up to a minute — the same App Store 2.1(b)
    /// reject pattern that bit the paywall (whose `refreshBilling()` reads the
    /// `users` row directly). The 20s idle (`timeoutIntervalForRequest`) timeout
    /// fails a stalled request fast as `URLError.timedOut`; `timeoutIntervalFor
    /// Resource` is left at the SDK default so a slow-but-progressing transfer
    /// isn't truncated. Mirrors `EdgeNetwork`'s bounding for the edge client, so
    /// every direct-Supabase loading path fails fast instead of hanging.
    ///
    /// Realtime is unaffected: the SDK's `RealtimeClientV2` uses its own
    /// websocket transport (not this `global.session`, which backs only the HTTP
    /// PostgREST/Auth clients), and its periodic heartbeat keeps the socket from
    /// tripping an idle timeout regardless.
    private static let boundedSession: URLSession = {
        let config = URLSessionConfiguration.default
        // 30s (was 20s): this session also backs the Auth client, so it bounds
        // token REFRESHES too. A 20s idle cap could fail a refresh against a
        // cold/loaded self-hosted GoTrue as `URLError.timedOut` → the SDK
        // surfaces it as no session → the app shows a spurious "session expired"
        // right at the 1h access-token boundary. 30s gives the refresh room
        // while staying well under URLSession.shared's 60s default (the App
        // Store 2.1(b) anti-hang reason this session exists at all).
        config.timeoutIntervalForRequest = 30
        return URLSession(configuration: config)
    }()

    public static let client: SupabaseClient = {
        SupabaseClient(
            supabaseURL: AppConfig.supabaseURL,
            supabaseKey: AppConfig.supabaseAnonKey,
            options: SupabaseClientOptions(
                auth: SupabaseClientOptions.AuthOptions(
                    storage: KeychainLocalStorage(),
                    redirectToURL: redirectURL,
                    flowType: .pkce
                ),
                global: SupabaseClientOptions.GlobalOptions(session: boundedSession)
            )
        )
    }()

    /// Best-effort access-token fetch for the current session. Returns nil
    /// when the user isn't signed in or the SDK throws — callers (notably
    /// ``EdgeAPI``) should treat nil as "send the request unauthenticated".
    public static func currentAccessToken() async -> String? {
        do {
            let session = try await client.auth.session
            return session.accessToken
        } catch {
            return nil
        }
    }

    /// Force a token refresh and return the new access token (US-1146). The SDK
    /// refreshes near-expiry on its own `session` access, but a token the server
    /// rejects with a 401 (clock skew, rotation) needs an explicit refresh +
    /// retry. Returns nil when there's no session to refresh or the refresh
    /// fails — the caller then surfaces the original auth error.
    public static func refreshAccessToken() async -> String? {
        do {
            let session = try await client.auth.refreshSession()
            return session.accessToken
        } catch {
            return nil
        }
    }
}
