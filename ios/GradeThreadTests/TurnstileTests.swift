import XCTest
@testable import GradeThread

/// US-368: covers the pure pieces of the native Turnstile challenge — the HTML
/// builder and the error semantics. The `WKWebView` host isn't exercised here
/// (it needs a live web view + network), but the document it loads is.
final class TurnstileTests: XCTestCase {
    func test_html_embedsSiteKeyAndCallbacks() {
        let html = Captcha.html(siteKey: "0xABC123")
        XCTAssertTrue(html.contains("data-sitekey=\"0xABC123\""))
        XCTAssertTrue(html.contains("https://challenges.cloudflare.com/turnstile/v0/api.js"))
        // Posts back over the handler the coordinator registers.
        XCTAssertTrue(html.contains("window.webkit.messageHandlers.\(Captcha.messageHandlerName)"))
        // All three lifecycle callbacks are wired.
        XCTAssertTrue(html.contains("data-callback=\"gtOnToken\""))
        XCTAssertTrue(html.contains("data-error-callback=\"gtOnError\""))
        XCTAssertTrue(html.contains("data-expired-callback=\"gtOnExpired\""))
    }

    func test_html_escapesSiteKey() {
        let html = Captcha.html(siteKey: "a\"><script>b")
        XCTAssertFalse(html.contains("a\"><script>b"))
        XCTAssertTrue(html.contains("a&quot;&gt;&lt;script&gt;b"))
    }

    func test_baseURL_isRegisteredDomain() {
        // Turnstile validates the rendering hostname against the key's allowed
        // domains; we must serve the widget from our registered domain.
        XCTAssertEqual(Captcha.baseURL.host, "gradethread.com")
    }

    func test_cancelledError_isSilent() {
        // Cancellation must not produce a user-facing toast.
        XCTAssertNil(Captcha.Error.cancelled.errorDescription)
        XCTAssertNotNil(Captcha.Error.widget("boom").errorDescription)
    }
}
