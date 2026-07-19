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
    // US-1521: legal-acceptance versions recorded at signup. Keep IN SYNC with the
    // web (src/lib/constants.ts LEGAL_VERSIONS) and the edge mirror (legal.ts).
    //
    // US-2017: that "keep in sync" used to be enforced by nothing but this
    // comment, and the failure is legally material — publishing a new ToS row
    // leaves both clients recording the OLD version, attesting users to a
    // document they were never shown. src/test/legal-version-parity.test.ts now
    // FAILS if these two constants diverge from the web or edge values, so the
    // instruction above is enforceable rather than aspirational.
    //
    // ⚠ STILL OPEN (US-2017 AC2): iOS has no re-acceptance gate. The web has
    // src/components/auth/legal-gate.tsx; this app never calls /api/legal, so a
    // NEW version is never re-presented to an existing iOS user. Parity of the
    // constants does not fix that, and the guard deliberately does not pretend
    // it does.
    static let legalTosVersion = "2026-04-01"
    static let legalPrivacyVersion = "2026-04-01"

    public enum Phase: Equatable {
        case loading       // initial bootstrap before .initialSession fires
        case signedOut
        case signedIn(User)
    }

    public private(set) var phase: Phase = .loading

    /// Last error from a user-facing auth action. View bindings can subscribe
    /// for toast presentation; the next successful action clears it.
    public var lastError: Error?

    /// US-1492: set true when GoTrue emits `.passwordRecovery` (the user opened a
    /// "Forgot password?" email link and its recovery session is now live). The
    /// shell watches this to auto-present ``ChangePasswordSheet`` so the user
    /// actually sets a NEW password instead of being silently signed in with the
    /// OLD one still valid. Cleared by the shell when the sheet is dismissed.
    public var passwordRecoveryRequested = false

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
            // US-1521: match the web signup — record legal-acceptance versions so
            // the 00142 trigger writes the legal_acceptances row + the users
            // tos_version/privacy_version columns (iOS previously sent neither, so
            // an iOS-signed-up account looked like it never accepted the legal
            // terms). Keep these IN SYNC with web src/lib/constants.ts
            // LEGAL_VERSIONS and the edge legal.ts mirror.
            data["tos_version"] = .string(Self.legalTosVersion)
            data["privacy_version"] = .string(Self.legalPrivacyVersion)
            data["legal_accepted_at"] = .string(
                ISO8601DateFormatter().string(from: Date())
            )
            _ = try await SupabaseShared.client.auth.signUp(
                email: email,
                password: password,
                data: data.isEmpty ? nil : data,
                captchaToken: captchaToken
            )
            // US-804: a successful signup makes this device eligible for the
            // one-time post-signup plan step. The flag carries no id yet (email
            // confirmation may not have signed the user in); it's attached to the
            // user id at first sign-in. Only runs when signUp didn't throw.
            // US-1523: stamped with the signup email so it can only resolve onto
            // THIS account — a different user signing in on the same device
            // can't inherit the offer.
            PlanSelectionState().markPendingEligibility(email: email)
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
    ///
    /// `appleUserId` is `ASAuthorizationAppleIDCredential.user` — recorded for
    /// foreground revocation monitoring (US-1172) ONLY after the exchange
    /// succeeds (US-1250). Recording it eagerly in the button handler stranded a
    /// stale id whenever the exchange failed, and let a subsequent email/password
    /// sign-in inherit it.
    public func signInWithApple(idToken: String, nonce: String, appleUserId: String, fullName: PersonNameComponents?) async {
        await run {
            _ = try await SupabaseShared.client.auth.signInWithIdToken(
                credentials: .init(provider: .apple, idToken: idToken, nonce: nonce)
            )
            // US-1250: the exchange succeeded, so this Apple credential now backs
            // a live session — only now persist its id so the foreground check
            // can detect a later revocation under Settings → Apple ID. A failed
            // exchange above returns before this line, leaving no stored id.
            AppleCredentialMonitor.record(userId: appleUserId)
            // Name is only available on the first Apple grant — store it as
            // user metadata so we have a display name without re-prompting.
            if let fullName, let name = await fullNameString(from: fullName) {
                _ = try? await SupabaseShared.client.auth.update(
                    user: UserAttributes(data: ["full_name": .string(name)])
                )
                // US-1521: handle_new_user created the public.users profile from a
                // NAME-LESS Apple token and there's no metadata→profile sync
                // trigger, so every Apple-first account had a NULL profile name
                // (workspace pickers showed "Shared workspace"). Write it straight
                // to public.users too — self-update RLS permits `full_name` (it's
                // not a protected column, see 00076). Best-effort; only runs on the
                // first grant (later sign-ins have fullName == nil), so it never
                // clobbers a name the user later changed.
                if let uid = SupabaseShared.client.auth.currentUser?.id {
                    struct NamePatch: Encodable { let full_name: String }
                    // Postgres normalizes uuid to lowercase; pass the lowercased
                    // string form so the row match is exact.
                    _ = try? await SupabaseShared.client
                        .from("users")
                        .update(NamePatch(full_name: name))
                        .eq("id", value: uid.uuidString.lowercased())
                        .execute()
                }
            }
            // US-804: a first-time Apple grant supplies the name, which is our
            // reliable signal that this is a brand-new account. US-1523: the
            // Apple exchange signs the user in IMMEDIATELY, so skip the pending
            // hop and mark this exact user id eligible — nothing device-level
            // another account could inherit.
            if fullName != nil, let uid = SupabaseShared.client.auth.currentUser?.id {
                PlanSelectionState().markEligible(userId: uid)
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
        // US-1492: surface exchange failures instead of swallowing them with
        // `try?`. An expired / already-used link, or a PKCE verifier mismatch
        // (guaranteed cross-device or after a reinstall), otherwise foregrounded
        // the app to NOTHING — the reviewer taps the email link and the screen
        // just sits there. On success the auth-state stream drives the phase (and
        // `.passwordRecovery` presents the change-password sheet); on failure we
        // put an actionable error on `lastError`, which LoginView renders.
        do {
            _ = try await SupabaseShared.client.auth.session(from: url)
            lastError = nil
        } catch {
            lastError = error
        }
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
        // US-1499: LOCAL-FIRST sign-out. supabase-swift propagates transport errors
        // from `auth.signOut()`, so doing the server revoke FIRST left an offline
        // (airplane-mode) user stuck signed-in — the throw skipped the local wipe,
        // `phase` stayed `.signedIn`, and the Settings row sat on a permanent
        // spinner with no feedback. Now the local session/keychain/state are cleared
        // and the phase is driven to `.signedOut` REGARDLESS of network; the server
        // revoke is best-effort.
        // US-1646: revoke the server-side refresh token BEFORE wiping the
        // keychain — the SDK reads the refresh token FROM the keychain to revoke
        // it, so the old order (keychain wipe first) silently skipped the revoke
        // and left a valid refresh token alive on the server. A SHORT timeout
        // keeps the US-1499 local-first guarantee: an offline/slow network can't
        // wedge sign-out, and the local teardown below always runs. Matches
        // deleteAccount()'s SDK-signout-before-keychain ordering.
        await Self.bestEffortSignOut(timeout: .seconds(3))
        // 1) Local teardown — always runs.
        try? KeychainLocalStorage().removeAll()
        // US-1172: forget the tracked Apple credential id so a later non-Apple
        // sign-in doesn't inherit a stale revocation check.
        AppleCredentialMonitor.clear()
        // 2) Leave the signed-in UI immediately instead of waiting on the network
        //    auth-state stream (which never arrives offline). The `.signedOut`
        //    phase change drives the shell to LoginView AND runs the ContentView
        //    cleanup (workspace scope, sync cursors, thumbnail cache — US-1493/1499).
        phase = .signedOut
        Telemetry.clearUser()
        lastError = nil
    }

    /// US-1646: await the SDK sign-out but give up after `timeout` so an
    /// offline/slow revoke can't block the local teardown. Best-effort — a
    /// failure or timeout is non-fatal (we're wiping the local session anyway).
    private static func bestEffortSignOut(timeout: Duration) async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask { try? await SupabaseShared.client.auth.signOut() }
            group.addTask { try? await Task.sleep(for: timeout) }
            _ = await group.next()  // whichever finishes first wins…
            group.cancelAll()       // …cancel the other.
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
        // US-1406: mirror `signOut()` — forget the tracked Apple credential id so
        // a later non-Apple sign-in doesn't inherit a stale revocation check that
        // would spuriously sign the new user out once Apple reports the orphaned
        // id as notFound/revoked.
        AppleCredentialMonitor.clear()
        // US-1493: drop the active workspace scope so a fresh sign-in on this
        // device can't inherit the deleted account's X-Workspace-Owner. The
        // .signedOut phase-change also clears it, but deleteAccount can race the
        // auth-state stream, so clear here too (idempotent).
        WorkspaceScope.clear()
        // US-1499: drive the phase to .signedOut locally instead of waiting on the
        // (best-effort, possibly-offline) auth-state stream — the account is gone
        // server-side, so the UI must leave immediately. This also runs the
        // ContentView `.signedOut` cleanup (thumbnail cache purge et al.). Only
        // reached on RPC success; an RPC failure threw above and kept the user on
        // the confirmation sheet with a surfaced error.
        phase = .signedOut
        Telemetry.clearUser()
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

    // `internal` (not `private`) so the @MainActor unit tests can drive event
    // handling directly without the live SDK stream (US-1492).
    func apply(event: AuthChangeEvent, session: Session?) {
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
                // No live session → forget any stored Apple credential id so a
                // later email/password sign-in on this device can't inherit a
                // stale revocation check (re-recorded on the next Apple sign-in).
                AppleCredentialMonitor.clear()
            }
        case .signedOut:
            phase = .signedOut
            Telemetry.clearUser()
            AppleCredentialMonitor.clear()
        case .passwordRecovery:
            // US-1492: a "Forgot password?" link exchange emits this event with a
            // live recovery session. Previously we did nothing here — so the user
            // was silently left in the app with their OLD password still valid,
            // never prompted to set a new one (the whole point of the reset).
            // Flag it so the shell auto-presents ChangePasswordSheet against this
            // live session. We deliberately DON'T flip `phase` here: the sheet is
            // presented over whatever surface is showing, and a successful
            // `updatePassword` emits `.userUpdated`, which drives the phase.
            passwordRecoveryRequested = true
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
