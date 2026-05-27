import Foundation
import Supabase

/// Single shared `SupabaseClient` instance configured from `AppConfig`.
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
    public static let client: SupabaseClient = {
        SupabaseClient(
            supabaseURL: AppConfig.supabaseURL,
            supabaseKey: AppConfig.supabaseAnonKey
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
