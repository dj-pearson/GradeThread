import Foundation
import Supabase
import SwiftUI

/// Observable wrapper around the Supabase auth state. Drives gating in
/// ``ProtectedRouteShell`` and exposes a small surface of action methods so
/// views don't reach into the SDK directly.
///
/// Bootstraps by tailing `supabase.auth.authStateChanges` (an `AsyncStream`
/// of `(event, session)`) from `task { }` on first render. The SDK emits an
/// `.initialSession` event synchronously on subscription, which means
/// `isLoading` flips to false after the first event without any extra
/// polling.
@MainActor
@Observable
public final class AuthStore {
    public enum Phase: Equatable {
        case loading       // initial bootstrap before .initialSession fires
        case signedOut
        case signedIn(User)
    }

    public private(set) var phase: Phase = .loading

    /// Last error from a user-facing auth action. View bindings can subscribe
    /// for toast presentation; the next successful action clears it.
    public var lastError: Error?

    private var streamTask: Task<Void, Never>?

    public init() {}

    public func start() {
        guard streamTask == nil else { return }
        streamTask = Task { [weak self] in
            guard let self else { return }
            for await (event, session) in SupabaseShared.client.auth.authStateChanges {
                self.apply(event: event, session: session)
            }
        }
    }

    public func stop() {
        streamTask?.cancel()
        streamTask = nil
    }

    // MARK: - Actions

    /// `captchaToken` (US-368): production GoTrue rejects these calls without a
    /// valid Turnstile token. Supplied by ``LoginView`` from the native
    /// challenge; nil on local/CI builds where no Turnstile site key is set, in
    /// which case the server has captcha disabled too.
    public func signIn(email: String, password: String, captchaToken: String? = nil) async {
        await run {
            _ = try await SupabaseShared.client.auth.signIn(
                email: email,
                password: password,
                captchaToken: captchaToken
            )
        }
    }

    public func signUp(email: String, password: String, fullName: String?, captchaToken: String? = nil) async {
        await run {
            var data: [String: AnyJSON] = [:]
            if let fullName, !fullName.isEmpty {
                data["full_name"] = .string(fullName)
            }
            _ = try await SupabaseShared.client.auth.signUp(
                email: email,
                password: password,
                data: data.isEmpty ? nil : data,
                captchaToken: captchaToken
            )
        }
    }

    /// Re-sends the signup confirmation email (US-810). Used by ``LoginView``
    /// when a sign-in is rejected with GoTrue's "email not confirmed" error and
    /// the user never clicked the original link. `type: .signup` re-issues the
    /// account-confirmation mail; the redirect lands back on the app's
    /// Universal Link so the existing ``handleAuthCallback`` deep-link flow
    /// completes the confirmation. `captchaToken` mirrors the other auth calls
    /// (prod GoTrue captcha-gates this endpoint too).
    public func resendConfirmation(email: String, captchaToken: String? = nil) async {
        await run {
            try await SupabaseShared.client.auth.resend(
                email: email,
                type: .signup,
                emailRedirectTo: SupabaseShared.redirectURL,
                captchaToken: captchaToken
            )
        }
    }

    public func resetPassword(email: String, captchaToken: String? = nil) async {
        await run {
            try await SupabaseShared.client.auth.resetPasswordForEmail(
                email,
                redirectTo: SupabaseShared.redirectURL,
                captchaToken: captchaToken
            )
        }
    }

    /// Used after the ``SignInWithAppleCoordinator`` resolves an Apple
    /// credential. Identity token bytes → string → Supabase exchange.
    public func signInWithApple(idToken: String, nonce: String, fullName: PersonNameComponents?) async {
        await run {
            _ = try await SupabaseShared.client.auth.signInWithIdToken(
                credentials: .init(provider: .apple, idToken: idToken, nonce: nonce)
            )
            // Name is only available on the first Apple grant — store it as
            // user metadata so we have a display name without re-prompting.
            if let fullName, let name = await fullNameString(from: fullName) {
                _ = try? await SupabaseShared.client.auth.update(
                    user: UserAttributes(data: ["full_name": .string(name)])
                )
            }
        }
    }

    public func continueWithGoogle() async {
        await run {
            // US-661: on iOS 17.4+ drive the flow ourselves so the redirect
            // lands on an https Universal Link (uninterceptable) rather than the
            // SDK's default custom-scheme web session. We fetch the provider
            // URL, run our own ASWebAuthenticationSession with an https callback,
            // then exchange the returned URL for a session (PKCE). Below 17.4 we
            // keep the SDK's built-in custom-scheme flow.
            if #available(iOS 17.4, *) {
                let url = try SupabaseShared.client.auth.getOAuthSignInURL(
                    provider: .google,
                    redirectTo: SupabaseShared.universalLinkRedirectURL
                )
                let callback = try await OAuthWebSession.run(
                    url: url,
                    callback: .universalLink(host: "gradethread.com", path: "/app/auth-callback")
                )
                _ = try await SupabaseShared.client.auth.session(from: callback)
            } else {
                _ = try await SupabaseShared.client.auth.signInWithOAuth(
                    provider: .google,
                    redirectTo: SupabaseShared.customSchemeRedirectURL
                )
            }
        }
    }

    /// Completes an auth handshake delivered to the app as a deep link / Universal
    /// Link (US-661) — e.g. a password-reset or magic-link email opened from Mail
    /// lands on `https://gradethread.com/app/auth-callback` (or the legacy custom
    /// scheme on older builds). Best-effort: a non-auth URL is ignored.
    public func handleAuthCallback(url: URL) async {
        // US-988: a custom scheme is claimable by any installed app, so on
        // iOS 17.4+ we accept ONLY the https Universal Link we own. Below 17.4
        // the Universal Link isn't usable as a redirect target, so the legacy
        // custom scheme is still honored.
        let allowCustomScheme: Bool = {
            if #available(iOS 17.4, *) { return false }
            return true
        }()
        guard Self.isAcceptableAuthCallback(url: url, allowCustomScheme: allowCustomScheme) else { return }
        _ = try? await SupabaseShared.client.auth.session(from: url)
    }

    /// Strict scheme+host+path matcher for the auth callback (US-988). Pure and
    /// static so it can be unit-tested without the Supabase SDK.
    ///
    /// The https branch accepts ONLY `https://gradethread.com/app/auth-callback*`
    /// — an exact host equality (rejecting look-alikes such as
    /// `gradethread.com.evil.com`) plus a `/app/auth-callback` path prefix. The
    /// claimable custom scheme (`com.gradethread.app://auth-callback`) is
    /// accepted only when `allowCustomScheme` is true (iOS < 17.4).
    // `nonisolated` so the synchronous, nonisolated unit tests can call this pure
    // matcher directly (AuthStore is @MainActor; without this the test target
    // fails to compile — "main actor-isolated static method in a synchronous
    // nonisolated context"). It touches no main-actor state, and the @MainActor
    // caller in handleAuthCallback can still call a nonisolated method freely.
    nonisolated static func isAcceptableAuthCallback(url: URL, allowCustomScheme: Bool) -> Bool {
        let scheme = url.scheme?.lowercased()
        let host = url.host?.lowercased()
        if scheme == "https" {
            return host == "gradethread.com" && url.path.hasPrefix("/app/auth-callback")
        }
        guard allowCustomScheme else { return false }
        return scheme == "com.gradethread.app" && host == "auth-callback"
    }

    /// Changes the signed-in user's password (US-818). Uses the authenticated
    /// Supabase session — GoTrue's `updateUser` requires a live session, so this
    /// is the in-app equivalent of the web "change password" flow (no email
    /// round-trip).
    ///
    /// Throws so the calling sheet can show a success vs. error state, unlike the
    /// fire-and-forget auth actions that surface on `lastError`.
    public func updatePassword(newPassword: String) async throws {
        _ = try await SupabaseShared.client.auth.update(
            user: UserAttributes(password: newPassword)
        )
    }

    public func signOut() async {
        await run {
            try await SupabaseShared.client.auth.signOut()
            // Belt-and-suspenders: even if the SDK skipped a cleanup branch,
            // wipe the keychain bucket. Idempotent.
            try? KeychainLocalStorage().removeAll()
        }
    }

    /// Permanently deletes the signed-in user's account (US-194). Calls
    /// the `delete_account` Postgres RPC (SECURITY DEFINER, scoped to
    /// auth.uid()) which removes the auth.users row + cascades all data,
    /// then tears down the now-orphaned local session.
    ///
    /// Throws so the calling sheet can distinguish success from failure
    /// — unlike the fire-and-forget auth actions, a failed delete must
    /// keep the user on the confirmation screen rather than silently
    /// dropping them back to a still-live account.
    public func deleteAccount() async throws {
        try await SupabaseShared.client.rpc("delete_account").execute()
        // The account is gone server-side; clear the local session +
        // keychain so the app falls back to LoginView. Best-effort — the
        // auth-state stream will also flip to .signedOut once the now-
        // invalid token fails to refresh.
        try? await SupabaseShared.client.auth.signOut()
        try? KeychainLocalStorage().removeAll()
    }

    // MARK: - Internals

    /// Runs a throwing action, surfacing the error on `lastError` instead of
    /// propagating. The auth state stream takes care of updating `phase`
    /// after a successful action, so we don't double-handle it here.
    private func run(_ action: @Sendable () async throws -> Void) async {
        do {
            try await action()
            lastError = nil
        } catch {
            lastError = error
        }
    }

    private func apply(event: AuthChangeEvent, session: Session?) {
        switch event {
        case .initialSession, .signedIn, .tokenRefreshed, .userUpdated:
            if let user = session?.user {
                phase = .signedIn(user)
                // US-191 — stamp Sentry + PostHog user context. No email /
                // PII (US-1014) — auth.uid is the only identifier we attach.
                Telemetry.setUser(id: user.id.uuidString)
            } else {
                phase = .signedOut
                Telemetry.clearUser()
            }
        case .signedOut:
            phase = .signedOut
            Telemetry.clearUser()
        case .passwordRecovery:
            // Recovery flows pop the user back to LoginView; let the next
            // event drive the actual phase change.
            break
        @unknown default:
            break
        }
    }

    private func fullNameString(from name: PersonNameComponents) -> String? {
        let formatter = PersonNameComponentsFormatter()
        formatter.style = .long
        let value = formatter.string(from: name).trimmingCharacters(in: .whitespaces)
        return value.isEmpty ? nil : value
    }
}
