import XCTest
@testable import GradeThread

/// US-3101 — the four doors into the app that did not exist, and the one number
/// that was on the wrong tab.
///
/// The thread running through all of it: a reseller reaches for these things
/// while standing in a shop with a garment in their hand. Every extra tap
/// between the lock screen and the camera is a decision they make without the
/// app instead.
@MainActor
final class QuickEntryTests: XCTestCase {

    // MARK: - Home-screen quick actions

    func test_everyShortcutInThePlistHasARoute() throws {
        // The plist strings and the enum are two lists that must agree, and a
        // typo in either is a quick action that silently does nothing. No
        // compiler catches it and no crash reports it, so it is checked here.
        let plistURL = Self.repoRoot.appendingPathComponent("ios/GradeThread/Info.plist")
        let data = try Data(contentsOf: plistURL)
        let plist = try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: data, format: nil)
                as? [String: Any]
        )
        let items = try XCTUnwrap(plist["UIApplicationShortcutItems"] as? [[String: Any]])
        XCTAssertEqual(items.count, 3, "three quick actions: prospect, add, scout")

        for item in items {
            let type = try XCTUnwrap(item["UIApplicationShortcutItemType"] as? String)
            XCTAssertNotNil(
                HomeScreenShortcut.route(forType: type),
                "\(type) is in Info.plist but HomeScreenShortcut does not route it"
            )
            let title = try XCTUnwrap(item["UIApplicationShortcutItemTitle"] as? String)
            XCTAssertFalse(title.isEmpty)
        }

        // And the other direction: an enum case with no plist entry is a
        // shortcut nobody can ever tap.
        let declared = Set(items.compactMap { $0["UIApplicationShortcutItemType"] as? String })
        for shortcut in HomeScreenShortcut.allCases {
            XCTAssertTrue(
                declared.contains(shortcut.rawValue),
                "\(shortcut.rawValue) is routed but not declared in Info.plist"
            )
        }
    }

    func test_shortcutTypesMapToTheRightRoutes() {
        XCTAssertEqual(HomeScreenShortcut.route(forType: HomeScreenShortcut.prospect.rawValue), .prospect)
        XCTAssertEqual(HomeScreenShortcut.route(forType: HomeScreenShortcut.addItem.rawValue), .addItem)
        XCTAssertEqual(HomeScreenShortcut.route(forType: HomeScreenShortcut.scout.rawValue), .scout)
        XCTAssertNil(
            HomeScreenShortcut.route(forType: "com.gradethread.app.shortcut.nope"),
            "an unknown type returns nil so the delegate reports the tap unhandled"
        )
    }

    // MARK: - Cold launch

    func test_theNewRoutesSurviveAColdLaunch() throws {
        // A quick action or a Lock Screen tap on a KILLED app is a cold launch
        // by definition — nobody long-presses the icon of an app already open in
        // front of them. Without a token these post into a bus nothing is
        // subscribed to yet and the seller lands on a bare Home, which is
        // exactly the bug US-1410 fixed for Siri.
        for route in [DeepLinkRoute.prospect, .scout, .inventoryDrafts] {
            let token = try XCTUnwrap(
                route.coldLaunchToken,
                "\(route) has no cold-launch token, so a killed-app tap is dropped"
            )
            XCTAssertEqual(
                DeepLinkRoute(coldLaunchToken: token), route,
                "the token does not round-trip"
            )
        }
    }

    func test_anUnknownTokenIsRefusedRatherThanGuessed() {
        XCTAssertNil(DeepLinkRoute(coldLaunchToken: "somethingElse"))
        XCTAssertNil(DeepLinkRoute(coldLaunchToken: ""))
    }

    // MARK: - The Lock Screen widget

    func test_theProspectWidgetLinkRoundTrips() throws {
        let url = WidgetDeepLink.prospect.url
        XCTAssertEqual(
            WidgetDeepLink.from(url: url), .prospect,
            "the widget builds a URL the app must parse back"
        )
        // The existing two are untouched.
        XCTAssertEqual(WidgetDeepLink.from(url: WidgetDeepLink.money.url), .money)
        XCTAssertEqual(WidgetDeepLink.from(url: WidgetDeepLink.marketplaces.url), .marketplaces)
    }

    func test_aWidgetLinkIsNeverMistakenForAnAuthCallback() throws {
        // The custom scheme is shared with the OAuth flow. A widget tap that
        // parsed as an auth redirect would be a security-relevant confusion,
        // not a routing one, so the host separation is asserted rather than
        // assumed.
        let url = WidgetDeepLink.prospect.url
        XCTAssertEqual(url.host, "widget")
        XCTAssertNotEqual(url.host, "auth-callback")
    }

    // MARK: - The Marketplaces badge

    func test_theBadgeIsNilAtZeroRatherThanZero() async {
        // A badge showing "0" draws the eye to say nothing is wrong, which is
        // the opposite of what a badge is for.
        let store = SellerAttentionStore(fetchCounts: {
            SellerAttentionCounts(offersAwaitingReply: 0, returnsWithDeadline: 0, disputesWithDeadline: 0)
        })
        await store.refresh()
        XCTAssertEqual(store.count, 0)
        XCTAssertNil(store.badgeCount, "zero must render nothing at all")

        let busy = SellerAttentionStore(fetchCounts: {
            SellerAttentionCounts(offersAwaitingReply: 2, returnsWithDeadline: 1, disputesWithDeadline: 0)
        })
        await busy.refresh()
        XCTAssertEqual(busy.badgeCount, 3)
    }

    func test_aFailedRefreshKeepsTheLastCount() async {
        // A network blip is not "nothing needs you". Same rule as
        // UnreadBadgeStore, and for the same reason.
        var shouldFail = false
        let store = SellerAttentionStore(fetchCounts: {
            if shouldFail { throw EdgeAPIError.network("offline") }
            return SellerAttentionCounts(offersAwaitingReply: 4, returnsWithDeadline: 0, disputesWithDeadline: 0)
        })
        await store.refresh()
        XCTAssertEqual(store.count, 4)

        shouldFail = true
        await store.refresh()
        XCTAssertEqual(store.count, 4, "a failed read must not clear a real count")
    }

    func test_signOutClearsTheBadge() async {
        let store = SellerAttentionStore(fetchCounts: {
            SellerAttentionCounts(offersAwaitingReply: 3, returnsWithDeadline: 0, disputesWithDeadline: 0)
        })
        await store.refresh()
        store.reset()
        XCTAssertNil(store.badgeCount, "the next account must not open on the last one's offers")
    }

    // MARK: - What counts as needing you

    func test_onlyPendingOffersCount() {
        let counts = SellerAttentionCounts.from(
            offers: [
                offer(id: "1", status: "PENDING"),
                offer(id: "2", status: "pending"),
                offer(id: "3", status: "ACCEPTED"),
                offer(id: "4", status: "DECLINED"),
                offer(id: "5", status: nil),
            ],
            returns: [],
            disputes: []
        )
        XCTAssertEqual(
            counts.offersAwaitingReply, 2,
            "an answered offer is a decision already made, and a status-less one is not a claim"
        )
    }

    func test_aDeadlineThatHasPassedIsNotCounted() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let future = ISO8601DateFormatter().string(from: now.addingTimeInterval(86_400))
        let past = ISO8601DateFormatter().string(from: now.addingTimeInterval(-86_400))

        let counts = SellerAttentionCounts.from(
            offers: [],
            returns: [
                aReturn(id: "live", respondBy: future),
                aReturn(id: "gone", respondBy: past),
                // No date at all: eBay is running no clock, so it is genuinely
                // less urgent than one it is. Same call the web's ranking makes.
                aReturn(id: "undated", respondBy: nil),
            ],
            disputes: [],
            now: now
        )
        XCTAssertEqual(counts.returnsWithDeadline, 1)
    }

    func test_bothIsoSpellingsParse() {
        // eBay sends fractional seconds on some payloads and not others, and
        // the wrong formatter options return nil rather than throwing — so a
        // real deadline silently became "no deadline" and dropped out.
        XCTAssertNotNil(ISO8601DateParser.date(from: "2026-09-09T00:00:00Z"))
        XCTAssertNotNil(ISO8601DateParser.date(from: "2026-09-09T00:00:00.000Z"))
        XCTAssertNil(ISO8601DateParser.date(from: "not a date"))
    }

    func test_theTotalIsTheSumOfTheThree() {
        let counts = SellerAttentionCounts(
            offersAwaitingReply: 2, returnsWithDeadline: 3, disputesWithDeadline: 1
        )
        XCTAssertEqual(counts.total, 6)
    }

    // MARK: - Drafts

    func test_theDraftStageIsTheOneTheHomeCountUses() {
        // Home's Publish count and the Inventory Drafts tab must agree, or the
        // seller taps a number and lands on a list that shows something else.
        // One definition, read by both.
        XCTAssertEqual(InventoryStage.drafts.matchingStatuses, ["drafted"])
    }

    // MARK: - Helpers

    static var repoRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private func offer(id: String, status: String?) -> BestOffer {
        BestOffer(bestOfferId: id, itemId: "i-\(id)", status: status)
    }

    private func aReturn(id: String, respondBy: String?) -> EbayReturn {
        EbayReturn(returnId: id, respondBy: respondBy)
    }
}
