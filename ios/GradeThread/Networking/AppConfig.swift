import Foundation

/// Build-time configuration sourced from `Info.plist`, which in turn pulls
/// its values from the active `.xcconfig` (Debug.xcconfig / Release.xcconfig).
///
/// No secrets live in source. Override the placeholder values in xcconfig
/// before shipping a real build.
enum AppConfig {
    /// Self-hosted Supabase Kong base URL (auth, DB, storage).
    static let supabaseURL: URL = {
        guard let url = url(forInfoKey: "SUPABASE_URL") else {
            fatalError("SUPABASE_URL missing or invalid in Info.plist — check xcconfig.")
        }
        return url
    }()

    /// Public Supabase anon key. Safe to ship in the bundle (RLS enforces
    /// access server-side), but still wired through xcconfig so the dev/prod
    /// projects can diverge without code changes.
    static let supabaseAnonKey: String = {
        guard let key = string(forInfoKey: "SUPABASE_ANON_KEY"),
              !key.isEmpty,
              key != "REPLACE_ME_WITH_REAL_SUPABASE_ANON_KEY"
        else {
            fatalError("SUPABASE_ANON_KEY missing in Info.plist — set it in xcconfig.")
        }
        return key
    }()

    /// Hono edge service base URL. Distinct from `supabaseURL` — Kong on
    /// `api.*` will 404 anything outside the Supabase route table.
    static let edgeAPIURL: URL = {
        guard let url = url(forInfoKey: "EDGE_API_URL") else {
            fatalError("EDGE_API_URL missing or invalid in Info.plist — check xcconfig.")
        }
        return url
    }()

    // MARK: - Internals

    private static func string(forInfoKey key: String) -> String? {
        Bundle.main.object(forInfoDictionaryKey: key) as? String
    }

    private static func url(forInfoKey key: String) -> URL? {
        guard let raw = string(forInfoKey: key), !raw.isEmpty else { return nil }
        return URL(string: raw)
    }
}
