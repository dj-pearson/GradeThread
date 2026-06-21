import CryptoKit
import Foundation

/// Sign in with Apple is driven end-to-end by the SwiftUI
/// `SignInWithAppleButton` in ``LoginView`` — its `onRequest` stashes a nonce
/// and `onCompletion` hands the identity token to ``AuthStore``.
///
/// US-1172: the old `ASAuthorizationController`-based handshake that used to
/// live here was a *second*, never-exercised credential path (the button never
/// called it), so it was removed to avoid two implementations drifting. Only
/// the shared, testable nonce helpers remain — consumed by the button's
/// `onRequest` and by `SignInWithAppleTests`.
///
/// Apple requires a nonce on the request that's SHA-256-hashed at the client;
/// the unhashed value is what we send to Supabase to prove the token wasn't
/// replayed. ``hashedNonce(_:)`` does the hashing; ``randomNonce(length:)``
/// generates the source.
public enum SignInWithAppleCoordinator {

    /// Cryptographically-random nonce of `length` URL-safe characters.
    public static func randomNonce(length: Int = 32) -> String {
        precondition(length > 0)
        let charset: [Character] = Array(
            "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-._"
        )
        var random = [UInt8](repeating: 0, count: length)
        let result = SecRandomCopyBytes(kSecRandomDefault, length, &random)
        precondition(result == errSecSuccess, "SecRandomCopyBytes failed")
        return String(random.map { charset[Int($0) % charset.count] })
    }

    public static func hashedNonce(_ input: String) -> String {
        let digest = SHA256.hash(data: Data(input.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

public enum SignInWithAppleError: LocalizedError {
    case missingIdentityToken

    public var errorDescription: String? {
        switch self {
        case .missingIdentityToken:
            return "Apple didn't return an identity token. Please try again."
        }
    }
}
