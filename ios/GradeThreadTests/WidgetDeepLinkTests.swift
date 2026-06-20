import XCTest
@testable import GradeThread

/// US-752: the home-screen widget deep-links on tap. These exercise the
/// URL contract the widget builds and the app parses in `onOpenURL`.
final class WidgetDeepLinkTests: XCTestCase {

    func test_url_roundTrips_forEveryDestination() {
        for link in WidgetDeepLink.allCases {
            XCTAssertEqual(WidgetDeepLink.from(url: link.url), link,
                           "\(link) did not round-trip through its URL")
        }
    }

    func test_url_usesAppSchemeAndWidgetHost() {
        let url = WidgetDeepLink.marketplaces.url
        XCTAssertEqual(url.scheme, "com.gradethread.app")
        XCTAssertEqual(url.host, WidgetDeepLink.host)
        XCTAssertEqual(url.path, "/marketplaces")
    }

    func test_money_destinationParses() {
        XCTAssertEqual(
            WidgetDeepLink.from(url: URL(string: "com.gradethread.app://widget/money")!),
            .money)
    }

    func test_from_rejectsAuthCallbackURL() {
        // A widget tap must never be confused with the auth-callback redirect,
        // and vice-versa — they share the scheme but use distinct hosts.
        let authCallback = URL(string: "com.gradethread.app://auth-callback#access_token=x")!
        XCTAssertNil(WidgetDeepLink.from(url: authCallback))
    }

    func test_from_rejectsUnknownHostAndPath() {
        XCTAssertNil(WidgetDeepLink.from(url: URL(string: "com.gradethread.app://widget/unknown")!))
        XCTAssertNil(WidgetDeepLink.from(url: URL(string: "https://gradethread.com/widget/money")!))
        XCTAssertNil(WidgetDeepLink.from(url: URL(string: "com.gradethread.app://other/money")!))
    }

    func test_authCallback_rejectsWidgetURL() {
        // The auth matcher (host == auth-callback) ignores widget URLs, so the
        // two onOpenURL branches can't both fire for the same tap.
        XCTAssertFalse(
            AuthStore.isAcceptableAuthCallback(
                url: WidgetDeepLink.money.url, allowCustomScheme: true))
    }
}
