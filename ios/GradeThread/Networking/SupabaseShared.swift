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

    public static let client: SupabaseClient = {
        SupabaseClient(
            supabaseURL: AppConfig.supabaseURL,
            supabaseKey: AppConfig.supabaseAnonKey,
            options: SupabaseClientOptions(
                auth: SupabaseClientOptions.AuthOptions(
                    storage: KeychainLocalStorage(),
                    redirectToURL: redirectURL,
                    flowType: .pkce
                )
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
