import SwiftUI
import WebKit

/// US-368: native Cloudflare Turnstile challenge.
///
/// Production GoTrue enforces captcha on `/auth/v1/signup`, the
/// email-password `/token` grant, and `/recover` — any such call without a
/// valid `gotrue_meta_security.captcha_token` is rejected with HTTP 400
/// `captcha protection: request disallowed`. The web app satisfies this by
/// rendering a Turnstile widget (`VITE_TURNSTILE_SITE_KEY`); this is the iOS
/// equivalent. Turnstile has no native SDK, so we host the standard widget in
/// a `WKWebView` and bridge the solved token back over a script-message
/// handler.
///
/// The Apple `signInWithIdToken` flow is **not** captcha-gated server-side, so
/// it deliberately skips this.
enum Captcha {
    /// Failure modes surfaced to the caller. Cancellation is modelled so the
    /// login view can stay silent (matching the Apple-cancel behaviour).
    enum Error: LocalizedError {
        case cancelled
        case widget(String)

        var errorDescription: String? {
            switch self {
            case .cancelled:
                return nil
            case .widget(let message):
                return "Couldn't complete the security check. \(message)"
            }
        }
    }

    /// Name of the `WKScriptMessageHandler` the injected JS posts to.
    static let messageHandlerName = "turnstile"

    /// Builds the self-contained HTML document that renders a managed
    /// Turnstile widget for `siteKey` and posts lifecycle events back to the
    /// native handler. Pure + deterministic so it can be unit-tested without a
    /// web view. The site key is HTML/JS-attribute-escaped defensively even
    /// though it comes from our own build config.
    static func html(siteKey: String) -> String {
        let escaped = siteKey
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        return """
        <!DOCTYPE html>
        <html>
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
        <style>
          html, body { margin: 0; padding: 0; background: transparent; }
          .wrap { display: flex; align-items: center; justify-content: center;
                  min-height: 100vh; -webkit-text-size-adjust: 100%; }
        </style>
        </head>
        <body>
          <div class="wrap">
            <div class="cf-turnstile"
                 data-sitekey="\(escaped)"
                 data-callback="gtOnToken"
                 data-error-callback="gtOnError"
                 data-expired-callback="gtOnExpired"
                 data-timeout-callback="gtOnExpired"></div>
          </div>
          <script>
            function gtPost(payload) {
              try {
                window.webkit.messageHandlers.\(messageHandlerName).postMessage(payload);
              } catch (e) {}
            }
            function gtOnToken(token) { gtPost({ event: "token", token: token }); }
            function gtOnError(code) { gtPost({ event: "error", code: String(code) }); }
            function gtOnExpired() { gtPost({ event: "expired" }); }
          </script>
        </body>
        </html>
        """
    }

    /// Origin the widget is served from. Turnstile validates the rendering
    /// hostname against the site key's allowed-domains list, so we load the
    /// document with our registered domain as the base URL — the same key the
    /// web app uses then accepts the iOS challenge.
    static let baseURL = URL(string: "https://gradethread.com")!
}

/// Modal that renders the Turnstile widget and resolves with a token. Presented
/// by ``LoginView`` immediately before an auth call that the server will
/// captcha-gate.
struct TurnstileSheet: View {
    let siteKey: String
    /// Called exactly once with the solved token, or an error
    /// (`Captcha.Error.cancelled` when the user backs out).
    let completion: (Result<String, Captcha.Error>) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var didFinish = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                TurnstileWebView(siteKey: siteKey) { result in
                    finish(result)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                Text("Confirming you're human…")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding(24)
            .navigationTitle("Security check")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { finish(.failure(.cancelled)) }
                }
            }
        }
        .interactiveDismissDisabled()
        .onDisappear {
            // Swipe-to-dismiss / programmatic teardown without a resolved
            // token reads as a cancel so the continuation never leaks.
            if !didFinish { completion(.failure(.cancelled)) }
        }
    }

    private func finish(_ result: Result<String, Captcha.Error>) {
        guard !didFinish else { return }
        didFinish = true
        completion(result)
        dismiss()
    }
}

/// `WKWebView` host that loads the Turnstile document and relays the widget's
/// callbacks. Reports the first terminal event (token or error) once.
private struct TurnstileWebView: UIViewRepresentable {
    let siteKey: String
    let onResult: (Result<String, Captcha.Error>) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onResult: onResult) }

    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: Captcha.messageHandlerName)

        let config = WKWebViewConfiguration()
        config.userContentController = controller
        // The interactive Turnstile checkbox can escalate to a managed challenge
        // that opens a secondary frame; without these the new frame is dropped
        // and the tap appears to do nothing.
        config.preferences.javaScriptCanOpenWindowsAutomatically = true

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.uiDelegate = context.coordinator
        // US-1226: gate navigations to an origin allowlist (our domain +
        // Cloudflare's challenge infra) so a managed-challenge popup or a
        // redirect can't load arbitrary content into the main frame.
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        webView.loadHTMLString(Captcha.html(siteKey: siteKey), baseURL: Captcha.baseURL)
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        uiView.configuration.userContentController
            .removeScriptMessageHandler(forName: Captcha.messageHandlerName)
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate {
        private let onResult: (Result<String, Captcha.Error>) -> Void
        private var didResolve = false

        init(onResult: @escaping (Result<String, Captcha.Error>) -> Void) {
            self.onResult = onResult
        }

        /// US-1226: hosts the widget loads from, plus the Cloudflare challenge
        /// infrastructure it escalates to. A navigation whose host isn't in (or a
        /// subdomain of) one of these — and isn't `about:` / a non-http(s) scheme
        /// like the Turnstile JS-bridge — is cancelled, so a popup/redirect can't
        /// pull arbitrary content into the web view.
        private static let allowedHosts: Set<String> = ["gradethread.com", "cloudflare.com"]

        /// True when `url` targets our domain or Cloudflare (or a subdomain of
        /// either), or is the `about:blank` placeholder. `http(s)` only — any
        /// other scheme is handled separately (see `decidePolicyFor`).
        private static func isAllowed(_ url: URL?) -> Bool {
            guard let url else { return false }
            if url.scheme == "about" { return true }
            guard url.scheme == "https" || url.scheme == "http" else { return false }
            guard let host = url.host?.lowercased() else { return false }
            return allowedHosts.contains { host == $0 || host.hasSuffix("." + $0) }
        }

        /// Origin allowlist for main- and sub-frame navigations. The initial
        /// `loadHTMLString(baseURL:)` and the Turnstile JS bridge (non-http
        /// schemes such as the message-handler callback) are permitted; anything
        /// else off-allowlist is cancelled rather than loaded.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            let url = navigationAction.request.url
            // Non-http(s) schemes (the in-page JS bridge / data loads) aren't
            // remote content fetches — leave them to WebKit.
            if let scheme = url?.scheme, scheme != "http", scheme != "https" {
                decisionHandler(.allow)
                return
            }
            decisionHandler(Self.isAllowed(url) ? .allow : .cancel)
        }

        /// Turnstile's managed challenge may request a popup frame
        /// (`targetFrame == nil`). WKWebView won't create one on its own — load
        /// it inline so the challenge can complete instead of stalling, but only
        /// when the request points at an allowlisted origin (US-1226).
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if navigationAction.targetFrame?.isMainFrame != true,
               Self.isAllowed(navigationAction.request.url) {
                webView.load(navigationAction.request)
            }
            return nil
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard !didResolve,
                  let body = message.body as? [String: Any],
                  let event = body["event"] as? String else { return }

            switch event {
            case "token":
                if let token = body["token"] as? String, !token.isEmpty {
                    resolve(.success(token))
                } else {
                    resolve(.failure(.widget("No token returned.")))
                }
            case "error":
                let code = (body["code"] as? String).map { "(\($0))" } ?? ""
                resolve(.failure(.widget("Please try again. \(code)".trimmingCharacters(in: .whitespaces))))
            case "expired":
                resolve(.failure(.widget("The check expired. Please try again.")))
            default:
                break
            }
        }

        private func resolve(_ result: Result<String, Captcha.Error>) {
            guard !didResolve else { return }
            didResolve = true
            onResult(result)
        }
    }
}
