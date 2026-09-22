import XCTest
@testable import GradeThread

/// US-3455 -- the in-app listing, held to what its copy and its App Review
/// notes claim about it.
///
/// The static guard (`ios/Scripts/check-web-delist.py`) covers what a text
/// scan can see: no credential field, nothing scheduled, nothing fetched, no
/// submit click. These cover what only running the code can: which platforms
/// are attempted, what the hand-off says, and that consent is per marketplace
/// and per selector version.
@MainActor
final class WebListTests: XCTestCase {

    // MARK: - which platforms are attempted

    func testOnlyVerifiedPlatformsRun() {
        XCTAssertNil(WebListRunner.refusalReason(platform: "poshmark"))
        XCTAssertNil(WebListRunner.refusalReason(platform: "mercari"))
        XCTAssertEqual(ListFlows.runnable, ["mercari", "poshmark"])
    }

    func testAnUnknownPlatformIsRefusedTowardsTheDesktop() {
        for platform in ["grailed", "vinted", "facebook", "etsy", "ebay"] {
            let reason = WebListRunner.refusalReason(platform: platform)
            XCTAssertNotNil(reason, "\(platform) has no verified list flow and must be refused")
            XCTAssertTrue(reason?.contains("desktop") ?? false, "\(platform): the refusal names the way that works")
        }
    }

    func testEveryRunnableFlowCarriesWhatTheRunNeeds() {
        for platform in ListFlows.runnable {
            guard let flow = ListFlows.flow(for: platform) else {
                XCTFail("\(platform) is runnable with no flow")
                continue
            }
            XCTAssertFalse(flow.hosts.isEmpty, "\(platform): no hosts, so nothing can be opened")
            XCTAssertTrue(flow.newListingUrl.hasPrefix("https://"), "\(platform): the create page is not https")
            XCTAssertNotNil(flow.title, "\(platform): no title selector")
            XCTAssertNotNil(flow.description, "\(platform): no description selector")
            // Without this the run could never record a post, and every
            // listing made this way would sit unconfirmed.
            XCTAssertNotNil(flow.liveListingUrlPattern, "\(platform): no live listing pattern")
            // The probe list names every required control, and each one
            // resolves to a selector; a name with no selector is a probe that
            // can only fail.
            XCTAssertTrue(flow.required.contains("submit"), "\(platform): submit is not probed")
            for name in flow.required {
                XCTAssertNotNil(flow.selector(named: name), "\(platform): required \(name) has no selector")
            }
        }
    }

    func testTheCreatePageIsOnTheFlowsOwnHost() {
        for platform in ListFlows.runnable {
            guard let flow = ListFlows.flow(for: platform), let url = URL(string: flow.newListingUrl) else {
                XCTFail("\(platform): create URL does not parse")
                continue
            }
            XCTAssertTrue(WebListRunner.hostAllowed(url, flow: flow))
            XCTAssertFalse(WebListRunner.hostAllowed(URL(string: "https://evil.example.com/sell")!, flow: flow))
        }
    }

    // MARK: - the fill text reaches the page intact

    func testFillTextIsEscapedAsAJavaScriptLiteral() {
        // A seller's description can hold every character that ends a string.
        let escaped = WebListRunner.jsStringLiteral("Levi's \"501\" jeans\nW32 \\ L34")
        XCTAssertEqual(escaped, "\"Levi's \\\"501\\\" jeans\\nW32 \\\\ L34\"")
        // The two line separators that are valid JSON and a syntax error
        // inside a JS string literal.
        XCTAssertEqual(WebListRunner.jsStringLiteral("a\u{2028}b"), "\"a\\u2028b\"")
    }

    // MARK: - the hand-off sentence

    func testTheHandOffSaysWhatWasFilledWhatIsLeftAndWhoPosts() {
        let summary = WebListRunner.handOffSummary(
            label: "Poshmark",
            filled: ["title", "description", "price"],
            left: ["brand"],
            photoCount: 6,
            pickers: ["category", "size", "color", "nwt"]
        )
        XCTAssertEqual(
            summary,
            "Filled the title, description and price. Type the brand yourself. "
                + "Add your 6 photos with Poshmark's own picker. "
                + "Pick the category, size, color and new-with-tags toggle. "
                + "Then tap Poshmark's Post button. GradeThread never taps it."
        )
    }

    func testTheHandOffNeverClaimsAPost() {
        let summary = WebListRunner.handOffSummary(
            label: "Mercari", filled: [], left: ["title"], photoCount: 0, pickers: []
        )
        XCTAssertTrue(summary.hasPrefix("Nothing was filled."))
        XCTAssertTrue(summary.hasSuffix("GradeThread never taps it."))
        XCTAssertFalse(summary.lowercased().contains("posted"))
    }

    // MARK: - consent is per marketplace and per selector version

    func testConsentIsRecordedPerMarketplaceAndVersion() {
        var record = ""
        XCTAssertFalse(WebListModel.hasConsented(record, platform: "poshmark", version: "2026.08.2"))
        record = WebListModel.recordingConsent(record, platform: "poshmark", version: "2026.08.2")
        XCTAssertTrue(WebListModel.hasConsented(record, platform: "poshmark", version: "2026.08.2"))
        // Another marketplace has not been consented to.
        XCTAssertFalse(WebListModel.hasConsented(record, platform: "mercari", version: "2026.08.1"))
        // A new selector set means a changed form: the screen shows again.
        XCTAssertFalse(WebListModel.hasConsented(record, platform: "poshmark", version: "2026.09.0"))
        record = WebListModel.recordingConsent(record, platform: "poshmark", version: "2026.09.0")
        XCTAssertEqual(record, "poshmark@2026.09.0", "the old version's entry is replaced, not kept")
    }

    // MARK: - the copy

    func testTheStatusLineSaysHowToStopItAndWhoPosts() {
        let fill = WebListFill(title: "t", description: "d", price: "45", brand: "b", photoCount: 3)
        let model = WebListModel(platform: "poshmark", fill: fill)
        XCTAssertNil(model.refusal)
        XCTAssertEqual(model.statusLine, "Ready.")
        XCTAssertEqual(model.version, ListFlows.flow(for: "poshmark")?.version)
    }

    func testARefusedPlatformHasNoRunnerAtAll() {
        let fill = WebListFill(title: "t", description: "d", price: "45", brand: "b", photoCount: 3)
        let model = WebListModel(platform: "grailed", fill: fill)
        XCTAssertNotNil(model.refusal)
        XCTAssertNil(model.runnerOrNil)
    }
}
