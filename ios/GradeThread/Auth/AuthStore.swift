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

    deinit {
        streamTask?.cancel()
    }

    // MARK: - Actions

    public func signIn(email: String, password: String) async {
        await run {
            _ = try await SupabaseShared.client.auth.signIn(
                email: email,
                password: password
            )
        }
    }

    public func signUp(email: String, password: String, fullName: String?) async {
        await run {
            var data: [String: AnyJSON] = [:]
            if let fullName, !fullName.isEmpty {
                data["full_name"] = .string(fullName)
            }
            _ = try await SupabaseShared.client.auth.signUp(
                email: email,
                password: password,
                data: data.isEmpty ? nil : data
            )
        }
    }

    public func resetPassword(email: String) async {
        await run {
            try await SupabaseShared.client.auth.resetPasswordForEmail(
                email,
                redirectTo: SupabaseShared.redirectURL
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
            if let fullName, let name = fullNameString(from: fullName) {
                _ = try? await SupabaseShared.client.auth.update(
                    user: UserAttributes(data: ["full_name": .string(name)])
                )
            }
        }
    }

    public func continueWithGoogle() async {
        await run {
            _ = try await SupabaseShared.client.auth.signInWithOAuth(
                provider: .google,
                redirectTo: SupabaseShared.redirectURL,
                scopes: "email profile"
            )
        }
    }

    public func signOut() async {
        await run {
            try await SupabaseShared.client.auth.signOut()
            // Belt-and-suspenders: even if the SDK skipped a cleanup branch,
            // wipe the keychain bucket. Idempotent.
            try? KeychainLocalStorage().removeAll()
        }
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
                // US-191 — stamp Sentry + PostHog user context.
                Telemetry.setUser(id: user.id.uuidString, email: user.email)
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
