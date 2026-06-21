import AuthenticationServices
import Foundation

/// US-1172: tracks the Apple user id from the most recent Sign in with Apple
/// and, on foreground, asks Apple whether that credential is still valid. If
/// the user revoked the app under Settings → Apple ID (or the credential is
/// otherwise gone), the stored session is dead — we sign out rather than leave
/// the user "signed in" against a credential Apple no longer honors.
///
/// Email/password (and any non-Apple) sessions have no stored id, so the check
/// is a no-op for them.
enum AppleCredentialMonitor {
    private static let userIdKey = "com.gradethread.auth.appleUserId"

    /// Persist the Apple user id after a successful Sign in with Apple
    /// (`ASAuthorizationAppleIDCredential.user`).
    static func record(userId: String) {
        UserDefaults.standard.set(userId, forKey: userIdKey)
    }

    /// Forget the stored id — called on sign-out / after handling a revocation
    /// so a later non-Apple sign-in doesn't carry a stale id.
    static func clear() {
        UserDefaults.standard.removeObject(forKey: userIdKey)
    }

    static var storedUserId: String? {
        UserDefaults.standard.string(forKey: userIdKey)
    }

    /// True when there's a stored Apple credential and Apple now reports it as
    /// `.revoked` or `.notFound`. `.authorized` (still good) and `.transferred`
    /// return false; no stored id also returns false. Uses the callback API
    /// (guaranteed available) bridged to async.
    static func isRevoked() async -> Bool {
        guard let userId = storedUserId else { return false }
        let state: ASAuthorizationAppleIDProvider.CredentialState =
            await withCheckedContinuation { cont in
                ASAuthorizationAppleIDProvider().getCredentialState(forUserID: userId) { state, _ in
                    cont.resume(returning: state)
                }
            }
        switch state {
        case .revoked, .notFound:
            return true
        default:
            return false
        }
    }
}
