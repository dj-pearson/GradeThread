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
    /// The Apple `user` is a durable per-user identifier, so it lives in the
    /// Keychain (encrypted at rest, this-device-only) rather than `UserDefaults`
    /// (an unencrypted plist readable from a backup / jailbroken device) —
    /// consistent with how the app stores its auth session. A dedicated service
    /// keeps it separate from the Supabase SDK's session store.
    private static let store = KeychainLocalStorage(service: "com.gradethread.app.apple-credential")
    private static let userIdKey = "appleUserId"
    /// The pre-Keychain `UserDefaults` location, kept only to migrate + scrub
    /// installs that still hold the id in plaintext.
    private static let legacyDefaultsKey = "com.gradethread.auth.appleUserId"

    /// Persist the Apple user id after a successful Sign in with Apple
    /// (`ASAuthorizationAppleIDCredential.user`).
    static func record(userId: String) {
        try? store.store(key: userIdKey, value: Data(userId.utf8))
        UserDefaults.standard.removeObject(forKey: legacyDefaultsKey)  // scrub legacy plaintext
    }

    /// Forget the stored id — called on sign-out / after handling a revocation
    /// so a later non-Apple sign-in doesn't carry a stale id.
    static func clear() {
        try? store.remove(key: userIdKey)
        UserDefaults.standard.removeObject(forKey: legacyDefaultsKey)
    }

    static var storedUserId: String? {
        if let stored = try? store.retrieve(key: userIdKey), let data = stored,
           let id = String(data: data, encoding: .utf8) {
            return id
        }
        // One-time migration: move a legacy UserDefaults value into the Keychain
        // and scrub the plaintext copy.
        if let legacy = UserDefaults.standard.string(forKey: legacyDefaultsKey) {
            try? store.store(key: userIdKey, value: Data(legacy.utf8))
            UserDefaults.standard.removeObject(forKey: legacyDefaultsKey)
            return legacy
        }
        return nil
    }

    /// True ONLY when there's a stored Apple credential and Apple definitively
    /// reports it as `.revoked`. No stored id returns false.
    ///
    /// We deliberately do NOT treat `.notFound` as revoked. `.notFound` is
    /// returned transiently whenever `getCredentialState` can't confirm the
    /// credential — offline, Apple ID server unreachable, the user momentarily
    /// signed out of their Apple ID on the device, or plain timing on a cold
    /// foreground. Because this check runs on EVERY foreground, treating a
    /// transient `.notFound` as revocation signed users out roughly daily (the
    /// symptom `IOS_APP_REVIEW_AUDIT_2026-06-30.md` flagged) — and, since a
    /// stored id can linger after an Apple session ends, it could even sign out a
    /// later email/password session on the same device. Only `.revoked` is the
    /// definitive "user revoked us under Settings → Apple ID" signal; a genuinely
    /// deleted credential also fails the GoTrue refresh, so the SDK's own
    /// refresh-failure path (not this heuristic) is the authority for a dead
    /// session. `.authorized`, `.transferred`, and `.notFound` all return false.
    static func isRevoked() async -> Bool {
        guard let userId = storedUserId else { return false }
        let state: ASAuthorizationAppleIDProvider.CredentialState =
            await withCheckedContinuation { cont in
                ASAuthorizationAppleIDProvider().getCredentialState(forUserID: userId) { state, _ in
                    cont.resume(returning: state)
                }
            }
        switch state {
        case .revoked:
            return true
        default:
            return false
        }
    }
}
