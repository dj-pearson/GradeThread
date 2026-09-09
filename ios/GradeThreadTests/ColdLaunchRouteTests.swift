import XCTest
@testable import GradeThread

/// A tap on a push notification with the app killed.
///
/// This is the single commonest cold launch the app gets, and until now it was
/// the one entry point that did not survive it. `UNUserNotificationCenter`'s
/// delegate is assigned in `didFinishLaunchingWithOptions`, and iOS delivers
/// `didReceive response` as soon as it is. `ContentView` has not mounted, so
/// nothing is subscribed to the deep-link bus and `DeepLinkRouter.post` reaches
/// no one. A seller who tapped "Your item sold" landed on Home.
///
/// The fix is the one US-1410 already made for Siri: persist the route and
/// replay it on startup. These tests hold the two halves of that: every route
/// round-trips through a token, and a token does not outlive its usefulness.
@MainActor
final class ColdLaunchRouteTests: XCTestCase {

    /// Every case of the enum, with an id where the case carries one. A new
    /// route added without a token is a new entry point that drops cold taps,
    /// so this list is deliberately exhaustive rather than a sample.
    private static let allRoutes: [DeepLinkRoute] = [
        .salesTab(inventoryItemId: "1f7c0a3e-0000-4000-8000-000000000001"),
        .salesTab(inventoryItemId: nil),
        .marketplacesTab,
        .reconnectEbay,
        .inventoryItem(id: "1f7c0a3e-0000-4000-8000-000000000002"),
        .inventoryTab,
        .negotiationInbox(filterItemId: "1f7c0a3e-0000-4000-8000-000000000003"),
        .negotiationInbox(filterItemId: nil),
        .gradesList,
        .captureItem,
        .addItem,
        .supportTickets(ticketId: "1f7c0a3e-0000-4000-8000-000000000004"),
        .supportTickets(ticketId: nil),
        .prospect,
        .scout,
        .inventoryDrafts,
        .pendingDelists(itemId: "1f7c0a3e-0000-4000-8000-000000000005"),
        .pendingDelists(itemId: nil),
    ]

    func test_everyRouteSurvivesAColdLaunchWithItsIdIntact() throws {
        for route in Self.allRoutes {
            let token = try XCTUnwrap(
                route.coldLaunchToken,
                "\(route) has no cold-launch token, so a killed-app tap is dropped"
            )
            XCTAssertEqual(
                DeepLinkRoute(coldLaunchToken: token), route,
                "\(route) does not round-trip through \(token)"
            )
        }
    }

    func test_anItemRouteWithNoIdIsRefusedRatherThanGuessed() {
        // `inventoryItem` is the only case whose id is required. A token that
        // lost it names no garment, and opening a random one is worse than
        // opening nothing.
        XCTAssertNil(DeepLinkRoute(coldLaunchToken: "inventoryItem"))
        XCTAssertNil(DeepLinkRoute(coldLaunchToken: "inventoryItem|"))
    }

    func test_anUnknownTokenIsRefused() {
        XCTAssertNil(DeepLinkRoute(coldLaunchToken: "somethingElse"))
        XCTAssertNil(DeepLinkRoute(coldLaunchToken: ""))
        XCTAssertNil(DeepLinkRoute(coldLaunchToken: "|abc"))
    }

    // MARK: - The clock on a persisted route

    func test_aFreshlyPersistedRouteDrainsOnce() {
        DeepLinkRouter.clearPending()
        let route = DeepLinkRoute.salesTab(inventoryItemId: "abc")
        DeepLinkRouter.persistPending(route)
        XCTAssertEqual(DeepLinkRouter.drainPending(), route)
        XCTAssertNil(DeepLinkRouter.drainPending(), "draining consumes the token")
    }

    func test_aStrandedRouteExpiresInsteadOfReplayingLater() {
        // The stranding case: the tap cold-launches the app, the user is signed
        // out, they abandon sign-in, and nothing drains the token. Replaying it
        // on an unrelated launch days later opens a screen the user did not ask
        // for and cannot explain.
        DeepLinkRouter.clearPending()
        let now = Date()
        DeepLinkRouter.persistPending(.negotiationInbox(filterItemId: "x"), now: now)
        XCTAssertNil(
            DeepLinkRouter.drainPending(now: now.addingTimeInterval(3600)),
            "an hour-old route should not replay"
        )
        DeepLinkRouter.persistPending(.negotiationInbox(filterItemId: "x"), now: now)
        XCTAssertEqual(
            DeepLinkRouter.drainPending(now: now.addingTimeInterval(30)),
            .negotiationInbox(filterItemId: "x"),
            "a route persisted thirty seconds ago is the launch in progress"
        )
    }

    func test_aBareTokenFromAnOlderBuildStillWorks() {
        // Upgrade path: a build before the timestamp existed wrote the token
        // alone. Someone mid-upgrade should not lose the tap that launched them.
        DeepLinkRouter.clearPending()
        UserDefaults.standard.set("prospect", forKey: "com.gradethread.app.pendingDeepLinkRoute")
        XCTAssertEqual(DeepLinkRouter.drainPending(), .prospect)
        XCTAssertNil(DeepLinkRouter.drainPending())
    }

    override func tearDown() {
        DeepLinkRouter.clearPending()
        super.tearDown()
    }
}
