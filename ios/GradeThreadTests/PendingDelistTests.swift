import XCTest
@testable import GradeThread

/// US-2481 AC1: sold elsewhere, still live on an extension channel.
///
/// What is pinned here is the refusal, not the happy path. The phone cannot end
/// a Poshmark listing — nothing outside the seller's own logged-in browser can,
/// per `vault/60-decisions/adr-no-server-side-marketplace-automation.md`. So the
/// only two honest offers are "queue it for the desktop" and "I ended it
/// myself", and each has rows it must NOT be offered for. Getting that wrong
/// costs a double sale: a second buyer pays for an item already shipped.
@MainActor
final class PendingDelistTests: XCTestCase {

    private func row(
        platform: String = "poshmark",
        url: String? = "https://poshmark.com/listing/abc-123",
        status: String? = "active"
    ) -> PendingDelistService.PendingDelist {
        PendingDelistService.PendingDelist(
            listingId: "l1",
            platform: platform,
            listingUrl: url,
            listingStatus: status,
            autoDelistable: true,
            itemId: "i1",
            itemTitle: "Vintage Levi's 501",
            requestedAt: "2026-08-11T00:00:00Z"
        )
    }

    func test_aLiveListingWithAUrlCanBeQueued() {
        XCTAssertNil(PendingDelistService.blockedReason(row()))
    }

    func test_aDraftIsRefusedInItsOwnWords_notAsAMissingUrl() {
        // Two different problems that send the seller two different places.
        // "No saved URL" for a listing that may never have been published sends
        // them hunting for something that does not exist.
        let reason = PendingDelistService.blockedReason(row(url: nil, status: "draft"))
        XCTAssertNotNil(reason)
        XCTAssertTrue(
            reason?.contains("never confirmed it went live") == true,
            "a draft must be named as never-confirmed-live, not as a missing URL"
        )
    }

    func test_aConfirmedListingWithNoUrlIsRefused() {
        XCTAssertTrue(
            PendingDelistService.blockedReason(row(url: nil))?
                .contains("No saved listing URL") == true
        )
        XCTAssertNotNil(
            PendingDelistService.blockedReason(row(url: "")),
            "an empty string counts as missing"
        )
    }

    func test_aChannelTheExtensionDoesNotHandleIsRefused() {
        // eBay, Shopify and Depop are ended server-side and never reach this
        // list. If one somehow does, queueing it would produce a job the drain
        // rejects — which reads, from the phone, exactly like one about to run.
        XCTAssertNotNil(PendingDelistService.blockedReason(row(platform: "ebay")))
        XCTAssertNotNil(PendingDelistService.blockedReason(row(platform: "depop")))
    }

    func test_everyChannelTheWebCanDelistIsOneThisPhoneCanQueue() {
        // Mirrors LISTER_EXTENSION_PLATFORMS in src/lib/lister-extension.ts and
        // EXTENSION_DELIST_PLATFORMS on Android. A channel that drops out of
        // this set silently loses its phone path.
        XCTAssertEqual(
            PendingDelistService.queueablePlatforms,
            ["poshmark", "mercari", "grailed", "vinted", "facebook"]
        )
        for platform in PendingDelistService.queueablePlatforms {
            XCTAssertNil(PendingDelistService.blockedReason(row(platform: platform)), platform)
        }
    }

    func test_queueingARefusedRowThrowsRatherThanQueueing() async {
        // A queued job the drain will refuse is worse than no job: it reads as
        // handled. The throw carries the same sentence the row already shows.
        do {
            _ = try await PendingDelistService.shared.queueForDesktop(row(platform: "ebay"))
            XCTFail("a channel the extension cannot run must not be queued")
        } catch let error as PendingDelistError {
            guard case .notQueueable(let reason) = error else { return XCTFail("wrong case") }
            XCTAssertEqual(reason, PendingDelistService.blockedReason(row(platform: "ebay")))
        } catch {
            XCTFail("expected PendingDelistError, got \(error)")
        }
    }

    func test_theQueuedNoticeIsTheOneEveryClientShows() {
        // Byte-identical with QUEUED_NOTICE in the edge's lib/extension-queue.ts,
        // src/hooks/use-extension-queue.ts and Android's ExtensionQueue.kt. The
        // delist row shows this string and no softened cousin of it.
        XCTAssertEqual(
            ExtensionQueueService.queuedNotice,
            "This runs the next time you open your desktop browser with the "
                + "GradeThread extension installed. Nothing happens on the marketplace "
                + "until then."
        )
    }
}
