import AuthenticationServices
import UIKit

/// Shared driver for `ASWebAuthenticationSession`-based OAuth handshakes
/// (US-661). Picks the callback mechanism per OS:
///
///   - **iOS 17.4+** uses `ASWebAuthenticationSession.Callback.https`, so the
///     redirect lands on an https Universal Link the app owns
///     (`applinks:gradethread.com`, AASA at
///     `/.well-known/apple-app-site-association`). A custom URL scheme is
///     claimable by ANY installed app, which could intercept the auth callback;
///     a Universal Link is bound to our Apple Team ID and can't be hijacked.
///   - **Below 17.4** falls back to the legacy custom-scheme callback so the
///     flow still works on the 17.0 deployment floor.
///
/// Both eBay (`EbayConnectionService`) and Supabase (Google sign-in) drive their
/// web auth through this one helper so the OS-version branching lives in a
/// single place.
@MainActor
enum OAuthWebSession {

    /// How the in-app browser hands control back to the app.
    enum Callback: Equatable {
        /// Legacy custom URL scheme (e.g. `com.gradethread.app`). Claimable by
        /// other apps — only used as the pre-17.4 fallback.
        case customScheme(String)
        /// https Universal Link the app owns via associated-domains. `path` is a
        /// prefix matched against the AASA components.
        case universalLink(host: String, path: String)
    }

    enum SessionError: LocalizedError, Equatable {
        case cancelled
        case noCallback
        case failed(String)

        var errorDescription: String? {
            switch self {
            case .cancelled:
                return "Sign-in was cancelled."
            case .noCallback:
                return "No callback URL received."
            case .failed(let message):
                return message
            }
        }
    }

    /// Retained presentation anchor — `ASWebAuthenticationSession` holds the
    /// context provider weakly, so a long-lived instance keeps it alive for
    /// callers (like `AuthStore`) that aren't themselves anchor providers.
    static let sharedAnchorProvider = DefaultPresentationAnchorProvider()

    /// Runs the web-auth session and resolves to the callback URL. Throws
    /// ``SessionError`` on cancel / failure.
    static func run(
        url: URL,
        callback: Callback,
        prefersEphemeralWebBrowserSession: Bool = true,
        anchorProvider: ASWebAuthenticationPresentationContextProviding? = nil
    ) async throws -> URL {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<URL, Error>) in
            // Hold a strong ref for the lifetime of the presentation; cleared in
            // the completion handler.
            var strongSession: ASWebAuthenticationSession?
            let handler: (URL?, Error?) -> Void = { callbackURL, error in
                strongSession = nil
                if let error {
                    let nsError = error as NSError
                    if nsError.domain == ASWebAuthenticationSessionErrorDomain,
                       nsError.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                        cont.resume(throwing: SessionError.cancelled)
                    } else {
                        cont.resume(throwing: SessionError.failed(error.localizedDescription))
                    }
                    return
                }
                guard let callbackURL else {
                    cont.resume(throwing: SessionError.noCallback)
                    return
                }
                cont.resume(returning: callbackURL)
            }

            let session: ASWebAuthenticationSession
            switch callback {
            case .universalLink(let host, let path):
                if #available(iOS 17.4, *) {
                    session = ASWebAuthenticationSession(
                        url: url,
                        callback: .https(host: host, path: path),
                        completionHandler: handler
                    )
                } else {
                    // Caller guards on availability before requesting a
                    // Universal Link callback; this branch is unreachable in
                    // practice but keeps the type total.
                    session = ASWebAuthenticationSession(
                        url: url,
                        callbackURLScheme: "com.gradethread.app",
                        completionHandler: handler
                    )
                }
            case .customScheme(let scheme):
                session = ASWebAuthenticationSession(
                    url: url,
                    callbackURLScheme: scheme,
                    completionHandler: handler
                )
            }

            session.presentationContextProvider = anchorProvider ?? sharedAnchorProvider
            // Isolate the web session — no shared Safari cookie jar, so another
            // app can't ride an existing login to drive a silent success.
            session.prefersEphemeralWebBrowserSession = prefersEphemeralWebBrowserSession
            strongSession = session
            session.start()
        }
    }
}

/// Default key-window presentation anchor for web-auth sessions.
@MainActor
final class DefaultPresentationAnchorProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        if let window = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .flatMap(\.windows)
            .first(where: { $0.isKeyWindow }) {
            return window
        }
        return ASPresentationAnchor()
    }
}
