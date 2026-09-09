import XCTest
@testable import GradeThread

/// US-3281 — the in-app delist, held to what its copy and its App Review notes
/// claim about it.
///
/// The static guard (`ios/Scripts/check-web-delist.py`) covers the properties a
/// text scan can see: no credential field, nothing scheduled, nothing fetched.
/// These cover the ones only running the code can: which URLs are refused,
/// which platforms are attempted, and whether a stopped run can restart itself.
///
/// The last of those is the one that matters most. A pause means a marketplace
/// asked whether a person is here, and GradeThread never answers that
/// (`vault/60-decisions/adr-no-server-side-marketplace-automation.md` §3.2). A
/// resume on a timer would be answering it by waiting, and it would look
/// exactly like working software.
@MainActor
final class WebDelistTests: XCTestCase {

    // MARK: - which URLs are opened at all

    func testRefusesAUrlThatIsNotTheMarketplace() {
        // The listing URL is stored server-side, which makes it exactly as
        // trusted as a message from a page: it says WHICH listing, not that the
        // destination is safe. Same rule as lister-guard.js on desktop.
        XCTAssertNotNil(
            WebDelistRunner.refusalReason(
                platform: "poshmark",
                listingURL: "https://evil.example.com/listing/1"
            ),
            "a poshmark row pointing somewhere else must be refused"
        )
    }

    func testRefusesPlainHttp() {
        XCTAssertNotNil(
            WebDelistRunner.refusalReason(
                platform: "poshmark",
                listingURL: "http://poshmark.com/listing/abc"
            ),
            "http is not opened, ever"
        )
    }

    func testRefusesAMissingUrl() {
        XCTAssertNotNil(
            WebDelistRunner.refusalReason(platform: "poshmark", listingURL: nil)
        )
        XCTAssertNotNil(
            WebDelistRunner.refusalReason(platform: "poshmark", listingURL: "")
        )
    }

    func testAcceptsTheMarketplaceAndItsSubdomains() {
        XCTAssertNil(
            WebDelistRunner.refusalReason(
                platform: "poshmark",
                listingURL: "https://poshmark.com/listing/abc-123"
            )
        )
        XCTAssertNil(
            WebDelistRunner.refusalReason(
                platform: "poshmark",
                listingURL: "https://www.poshmark.com/listing/abc-123"
            )
        )
    }

    func testASuffixThatOnlyLooksLikeTheHostIsRefused() {
        // `poshmark.com.evil.example` ends in the attacker's domain and starts
        // with ours. A `contains` check passes it; the suffix check does not.
        XCTAssertNotNil(
            WebDelistRunner.refusalReason(
                platform: "poshmark",
                listingURL: "https://poshmark.com.evil.example/listing/1"
            )
        )
        XCTAssertNotNil(
            WebDelistRunner.refusalReason(
                platform: "poshmark",
                listingURL: "https://notposhmark.com/listing/1"
            )
        )
    }

    // MARK: - which platforms are attempted

    func testOnlyVerifiedPlatformsRun() {
        // Grailed, Vinted and Facebook carry draft delist selectors on desktop.
        // The phone must refuse them by name rather than aim unverified
        // selectors at a real listing (US-2165: fail loudly).
        for platform in ["grailed", "vinted", "facebook"] {
            let reason = WebDelistRunner.refusalReason(
                platform: platform,
                listingURL: "https://\(platform).com/listings/1"
            )
            XCTAssertNotNil(reason, "\(platform) has an unverified flow and must be refused")
        }
        XCTAssertTrue(DelistFlows.runnable.contains("poshmark"))
        XCTAssertTrue(DelistFlows.runnable.contains("mercari"))
    }

    func testAnUnknownPlatformIsRefusedRatherThanGuessedAt() {
        XCTAssertNotNil(
            WebDelistRunner.refusalReason(
                platform: "etsy",
                listingURL: "https://www.etsy.com/listing/1"
            )
        )
    }

    // MARK: - the selectors reach the page intact

    func testSelectorEscapingSurvivesTheDoubleQuotesEverySelectorHas() {
        // Every marketplace selector contains `[data-test="…"]`. A naive
        // concatenation ends the JavaScript literal in the middle of one and
        // evaluates whatever follows.
        let escaped = WebDelistRunner.jsStringLiteral("button[data-test=\"confirm-delete\"]")
        XCTAssertEqual(escaped, "\"button[data-test=\\\"confirm-delete\\\"]\"")
        // A backslash in a selector must not become an escape of its own.
        XCTAssertEqual(
            WebDelistRunner.jsStringLiteral("a\\b"),
            "\"a\\\\b\""
        )
    }

    func testEveryRunnableFlowCarriesTheSelectorsTheRunNeeds() {
        for platform in DelistFlows.runnable {
            guard let flow = DelistFlows.flow(for: platform) else {
                XCTFail("\(platform) is runnable with no flow")
                continue
            }
            XCTAssertFalse(flow.hosts.isEmpty, "\(platform): no hosts, so nothing can be opened")
            XCTAssertNotNil(flow.menu, "\(platform): no menu selector")
            XCTAssertNotNil(flow.remove, "\(platform): no remove selector")
            // Without this the run cannot tell an end from a click that landed
            // on nothing, and would report a success it did not verify.
            XCTAssertNotNil(
                flow.goneWhenEnded,
                "\(platform): nothing to check the listing actually ended by"
            )
        }
    }

    // MARK: - the copy

    func testTheConsentRiskSentenceIsTheWebsSentence() {
        // Byte-identical to MECHANISM_DISCLOSURE.extension's first fact in
        // src/lib/marketplace-disclosure.ts, already mirrored in
        // MarketplacesView. A gentler phone disclosure is the inconsistency
        // that costs most if anyone lines the two up.
        XCTAssertEqual(
            WebDelistModel.riskDisclosure(label: "Poshmark"),
            "Poshmark's terms restrict third-party automation. Plenty of sellers use tools "
                + "like this one, and Poshmark can still limit an account it decides is automated."
        )
    }

    func testTheDrivingLineSaysHowToStopIt() {
        let model = WebDelistModel(row: Self.row(platform: "poshmark"))
        XCTAssertEqual(
            model.statusLine,
            "Ready.",
            "an unstarted run says nothing is happening"
        )
        XCTAssertNil(model.refusal, "a good poshmark row is not refused")
    }

    func testARefusedRowHasNoRunnerAtAll() {
        // Stronger than a runner that declines to start: there is no web view
        // to render, so there is no path to a page.
        let model = WebDelistModel(row: Self.row(platform: "grailed"))
        XCTAssertNotNil(model.refusal)
        XCTAssertNil(model.runnerOrNil)
    }

    // MARK: - fixtures

    private static func row(platform: String) -> PendingDelistService.PendingDelist {
        PendingDelistService.PendingDelist(
            listingId: "listing-1",
            platform: platform,
            listingUrl: "https://\(platform).com/listing/abc",
            listingStatus: "active",
            autoDelistable: true,
            itemId: "item-1",
            itemTitle: "Levi's 501 W32",
            requestedAt: "2026-09-09T12:00:00Z"
        )
    }
}
