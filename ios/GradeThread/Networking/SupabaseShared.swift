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
    /// OAuth redirect target matched by ``Info.plist``'s `CFBundleURLTypes`
    /// entry. The SDK launches `ASWebAuthenticationSession` and waits for
    /// the browser to bounce back to this URL, which iOS then delivers to
    /// the app via the registered URL scheme.
    public static let redirectURL = URL(string: "com.gradethread.app://auth-callback")!

    public static let client: SupabaseClient = {
        SupabaseClient(
            supabaseURL: AppConfig.supabaseURL,
            supabaseKey: AppConfig.supabaseAnonKey,
            options: SupabaseClientOptions(
                auth: SupabaseClientOptions.AuthOptions(
                    storage: KeychainLocalStorage(),
                    flowType: .pkce,
                    redirectToURL: redirectURL
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
}
