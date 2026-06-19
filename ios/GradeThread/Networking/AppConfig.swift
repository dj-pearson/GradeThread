import Foundation

/// Build-time configuration sourced from `Info.plist`, which in turn pulls
/// its values from the active `.xcconfig` (Debug.xcconfig / Release.xcconfig).
///
/// No secrets live in source. Override the placeholder values in xcconfig
/// before shipping a real build.
enum AppConfig {
    /// Self-hosted Supabase Kong base URL (auth, DB, storage). MUST be https —
    /// a plaintext base URL is a config-drift bug we refuse to launch with.
    static let supabaseURL: URL = {
        guard let url = httpsURL(forInfoKey: "SUPABASE_URL") else {
            fatalError("SUPABASE_URL missing, malformed, or not https in Info.plist — base URLs MUST be https. Check xcconfig.")
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
    /// `api.*` will 404 anything outside the Supabase route table. MUST be https.
    static let edgeAPIURL: URL = {
        guard let url = httpsURL(forInfoKey: "EDGE_API_URL") else {
            fatalError("EDGE_API_URL missing, malformed, or not https in Info.plist — base URLs MUST be https. Check xcconfig.")
        }
        return url
    }()

    /// Sentry DSN (US-191). Empty string in xcconfig disables Sentry
    /// silently — analytics + crash reporting are opt-in best-effort,
    /// not load-bearing on app launch.
    static var sentryDSN: String? {
        nonEmptyString(forInfoKey: "SENTRY_DSN")
    }

    /// PostHog project API key (US-191). Empty → analytics disabled.
    static var postHogAPIKey: String? {
        nonEmptyString(forInfoKey: "POSTHOG_API_KEY")
    }

    /// PostHog instance host. Defaults to the US cloud; xcconfig can
    /// override for EU/self-hosted.
    static var postHogHost: URL {
        url(forInfoKey: "POSTHOG_HOST")
            ?? URL(string: "https://us.i.posthog.com")!
    }

    /// Cloudflare Turnstile **site** key (US-368). Production GoTrue enforces
    /// captcha on signup / email-password sign-in / password-reset, rejecting
    /// any such call that lacks a `gotrue_meta_security.captcha_token`. When
    /// this key is present the app renders the Turnstile widget and forwards
    /// the resulting token; when it's empty (local dev / CI) the captcha step
    /// is a silent no-op — mirroring the web app's `VITE_TURNSTILE_SITE_KEY`
    /// gating. The matching secret lives only on the server.
    static var turnstileSiteKey: String? {
        nonEmptyString(forInfoKey: "TURNSTILE_SITE_KEY")
    }

    /// Whether "Continue with Google" is offered on the login screen.
    /// Temporarily OFF: the native Google OAuth handshake isn't reliable on
    /// device yet, so we ship Apple + email/password only and re-enable this
    /// once the flow is fixed. Flip back to `true` to restore the button.
    static let googleSignInEnabled = false

    // MARK: - Internals

    private static func string(forInfoKey key: String) -> String? {
        Bundle.main.object(forInfoDictionaryKey: key) as? String
    }

    /// String accessor that treats whitespace-only values as nil.
    /// Sentry / PostHog placeholders in xcconfig come through as empty
    /// strings when the operator hasn't filled them in; this catches
    /// that case so the call site doesn't have to recheck.
    private static func nonEmptyString(forInfoKey key: String) -> String? {
        guard let raw = string(forInfoKey: key) else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func url(forInfoKey key: String) -> URL? {
        guard let raw = string(forInfoKey: key), !raw.isEmpty else { return nil }
        return URL(string: raw)
    }

    /// Base-URL accessor that REQUIRES an `https` scheme. Returns `nil` for a
    /// missing, malformed, or non-https value so the caller fails fast. ATS
    /// would already block a plaintext `http://` connection at runtime, but a
    /// non-https base URL is a config-drift bug we refuse to launch with — the
    /// failure should be loud and immediate, not a silent connection error.
    private static func httpsURL(forInfoKey key: String) -> URL? {
        validatedHTTPSURL(from: string(forInfoKey: key))
    }

    /// Pure, testable scheme validation: accepts only well-formed `https` URLs
    /// with a non-empty host. `internal` so unit tests can exercise the reject
    /// paths without tripping the `fatalError` in the base-URL accessors.
    static func validatedHTTPSURL(from raw: String?) -> URL? {
        guard let raw, !raw.isEmpty,
              let url = URL(string: raw),
              url.scheme?.lowercased() == "https",
              let host = url.host, !host.isEmpty
        else { return nil }
        return url
    }
}
