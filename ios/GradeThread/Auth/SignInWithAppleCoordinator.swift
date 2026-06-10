import AuthenticationServices
import CryptoKit
import Foundation
import UIKit

/// Drives the Sign in with Apple handshake end-to-end and surfaces the
/// resulting credential to ``AuthStore``.
///
/// Apple requires a nonce on the request that's SHA-256-hashed at the
/// client. The unhashed value is what we ultimately send to Supabase to
/// prove the token wasn't replayed. ``hashedNonce(_:)`` does the hashing;
/// ``randomNonce(length:)`` generates the source.
@MainActor
public final class SignInWithAppleCoordinator: NSObject {
    public struct Result {
        public let idToken: String
        public let unhashedNonce: String
        public let fullName: PersonNameComponents?
    }

    public override init() { super.init() }

    private var continuation: CheckedContinuation<Result, Error>?
    private var currentNonce: String?

    /// Presents the Apple sign-in UI and returns the credential payload.
    /// Throws if the user cancels (`ASAuthorizationError.canceled`) or if
    /// the identity token is missing from the response.
    public func start() async throws -> Result {
        let nonce = Self.randomNonce()
        currentNonce = nonce

        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName, .email]
        request.nonce = Self.hashedNonce(nonce)

        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Result, Error>) in
            continuation = cont
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    // MARK: - Nonce helpers (testable)

    /// Cryptographically-random nonce of `length` URL-safe characters.
    public nonisolated static func randomNonce(length: Int = 32) -> String {
        precondition(length > 0)
        let charset: [Character] = Array(
            "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-._"
        )
        var random = [UInt8](repeating: 0, count: length)
        let result = SecRandomCopyBytes(kSecRandomDefault, length, &random)
        precondition(result == errSecSuccess, "SecRandomCopyBytes failed")
        return String(random.map { charset[Int($0) % charset.count] })
    }

    public nonisolated static func hashedNonce(_ input: String) -> String {
        let digest = SHA256.hash(data: Data(input.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - ASAuthorizationControllerDelegate

extension SignInWithAppleCoordinator: ASAuthorizationControllerDelegate {
    public func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        defer {
            continuation = nil
            currentNonce = nil
        }

        guard
            let appleCred = authorization.credential as? ASAuthorizationAppleIDCredential,
            let tokenData = appleCred.identityToken,
            let idToken = String(data: tokenData, encoding: .utf8),
            let nonce = currentNonce
        else {
            continuation?.resume(throwing: SignInWithAppleError.missingIdentityToken)
            return
        }

        continuation?.resume(
            returning: Result(
                idToken: idToken,
                unhashedNonce: nonce,
                fullName: appleCred.fullName
            )
        )
    }

    public func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        continuation?.resume(throwing: error)
        continuation = nil
        currentNonce = nil
    }
}

// MARK: - Presentation anchor

extension SignInWithAppleCoordinator: ASAuthorizationControllerPresentationContextProviding {
    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        // Prefer the foreground-active scene's key window, falling back through
        // real windows before a detached anchor (shared with the web-auth flows).
        WebAuthPresentationAnchor.resolve()
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
