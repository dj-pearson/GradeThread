import XCTest
@testable import GradeThread

/// US-1008 — base URLs must be https. AppConfig refuses any non-https
/// `SUPABASE_URL` / `EDGE_API_URL` (fatal-error at launch); these cover the
/// pure validator so the reject paths are exercised without crashing the test
/// process, plus a guard that the shipped config resolves to https.
final class AppConfigTests: XCTestCase {
    func test_validatedHTTPSURL_acceptsHTTPS() {
        let url = AppConfig.validatedHTTPSURL(from: "https://api.gradethread.com")
        XCTAssertNotNil(url)
        XCTAssertEqual(url?.scheme, "https")
        XCTAssertEqual(url?.host, "api.gradethread.com")
    }

    func test_validatedHTTPSURL_rejectsHTTP() {
        XCTAssertNil(AppConfig.validatedHTTPSURL(from: "http://api.gradethread.com"))
    }

    func test_validatedHTTPSURL_rejectsOtherSchemes() {
        XCTAssertNil(AppConfig.validatedHTTPSURL(from: "ftp://api.gradethread.com"))
        XCTAssertNil(AppConfig.validatedHTTPSURL(from: "ws://functions.gradethread.com"))
    }

    func test_validatedHTTPSURL_rejectsEmptyMalformedOrHostless() {
        XCTAssertNil(AppConfig.validatedHTTPSURL(from: nil))
        XCTAssertNil(AppConfig.validatedHTTPSURL(from: ""))
        XCTAssertNil(AppConfig.validatedHTTPSURL(from: "not a url"))
        XCTAssertNil(AppConfig.validatedHTTPSURL(from: "https://")) // no host
    }

    func test_configuredBaseURLs_areHTTPS() {
        // The shipped Debug/CI config must resolve to https endpoints; if it
        // didn't, AppConfig would have fatal-errored before reaching here.
        XCTAssertEqual(AppConfig.supabaseURL.scheme, "https")
        XCTAssertEqual(AppConfig.edgeAPIURL.scheme, "https")
    }
}
