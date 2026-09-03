import XCTest
@testable import GradeThread

/// US-3105 — the two lifecycle kinds the phone could not queue.
///
/// The server has accepted all four since US-9202/US-9203 and the extension has
/// run all four since then. The phone's enum stopped at `list` and `delist`, so
/// a seller who dropped a price in a shop had no way to get that price onto
/// their live Poshmark listing until they were back at a desk — and until then
/// the listing advertised the old one to every buyer who saw it.
@MainActor
final class ExtensionLifecycleTests: XCTestCase {

    // MARK: - The four kinds

    func test_allFourKindsRoundTrip() throws {
        // The enum and EXTENSION_QUEUE_KINDS in the edge's lib/extension-queue.ts
        // are one list in two languages. A kind the phone cannot encode is a
        // feature the phone cannot use; a kind it cannot DECODE is a queue row
        // that breaks the whole snapshot read.
        let expected = ["list", "delist", "revise", "relist"]
        XCTAssertEqual(
            ExtensionQueueService.Kind.allCases.map(\.rawValue),
            expected
        )
        for raw in expected {
            XCTAssertEqual(
                ExtensionQueueService.Kind(rawValue: raw)?.rawValue,
                raw,
                "\(raw) does not round-trip"
            )
        }
    }

    func test_theRevisableFieldsMatchTheServersList() {
        // REVISABLE_FIELDS in services/edge-functions/src/lib/pending-revises.ts.
        // A field the phone names and the server refuses is a 400 the seller
        // reads as a broken button.
        XCTAssertEqual(
            ExtensionQueueService.ReviseField.allCases.map(\.rawValue),
            ["price", "title", "description", "photos"]
        )
    }

    func test_aReviseWithNoFieldsIsRefusedBeforeTheRequest() async {
        // The route refuses an empty `fields` array. Sending one anyway spends a
        // round trip to be told what the client already knew.
        do {
            _ = try await ExtensionQueueService.shared.enqueueRevise(
                listingId: "L-1",
                platform: "poshmark",
                fields: []
            )
            XCTFail("an empty revise must not reach the network")
        } catch let error as ExtensionQueueService.ExtensionQueueError {
            XCTAssertEqual(error, .nothingToRevise)
        } catch {
            XCTFail("wrong error: \(error)")
        }
    }

    // MARK: - Which listings offer what

    func test_aLivePoshmarkListingWithAChangedPriceOffersBoth() {
        let actions = ExtensionLifecycle.actions(
            platform: "poshmark",
            status: "active",
            hasUrl: true,
            targetPrice: 45,
            listedPrice: 52
        )
        XCTAssertEqual(actions.reviseFields, [.price])
        XCTAssertTrue(actions.canRelist)
        XCTAssertNil(actions.relistWarning, "Poshmark can end its own listing")
    }

    func test_anUnchangedPriceOffersRelistButNotRevise() {
        // Nothing to send is not the same as nothing to do: the listing can
        // still be relisted, which is what a stale listing needs.
        let actions = ExtensionLifecycle.actions(
            platform: "mercari",
            status: "active",
            hasUrl: true,
            targetPrice: 50,
            listedPrice: 50
        )
        XCTAssertFalse(actions.canRevise)
        XCTAssertTrue(actions.canRelist)
    }

    func test_aPriceDifferingByLessThanACentIsNotAChange() {
        // Floating-point noise off a currency round-trip must not present the
        // seller with an update that changes nothing.
        let actions = ExtensionLifecycle.actions(
            platform: "poshmark",
            status: "active",
            hasUrl: true,
            targetPrice: 50.001,
            listedPrice: 50.0
        )
        XCTAssertFalse(actions.canRevise)
    }

    func test_aDraftOffersNothing() {
        // GradeThread only ever prefilled a draft; it was never published. A job
        // queued against one is refused by the drain, which reads to the seller
        // as handled.
        let actions = ExtensionLifecycle.actions(
            platform: "poshmark",
            status: "draft",
            hasUrl: true,
            targetPrice: 45,
            listedPrice: 52
        )
        XCTAssertEqual(actions, .none)
    }

    func test_aListingWithNoUrlOffersNothing() {
        // The extension opens the listing by URL and host-pins it (US-1876).
        // With no URL there is nothing for it to open.
        let actions = ExtensionLifecycle.actions(
            platform: "poshmark",
            status: "active",
            hasUrl: false,
            targetPrice: 45,
            listedPrice: 52
        )
        XCTAssertEqual(actions, .none)
    }

    func test_ebayAndShopifyOfferNothingHere() {
        // Both have write APIs and their own controls. Offering a queued
        // instruction beside a live API path would be two ways to do one thing,
        // one of which needs a browser to be open.
        for platform in ["ebay", "shopify", "depop"] {
            XCTAssertEqual(
                ExtensionLifecycle.actions(
                    platform: platform,
                    status: "active",
                    hasUrl: true,
                    targetPrice: 45,
                    listedPrice: 52
                ),
                .none,
                "\(platform) must not offer extension lifecycle actions"
            )
        }
    }

    func test_grailedWarnsThatTheOldListingStaysUp() {
        // Grailed's delete is confirmed by a NATIVE browser dialog nothing in a
        // page can answer, so a relist leaves the old listing live. Said BEFORE
        // the tap: the alternative is two copies of one garment on sale.
        let actions = ExtensionLifecycle.actions(
            platform: "grailed",
            status: "active",
            hasUrl: true,
            targetPrice: 45,
            listedPrice: 52
        )
        XCTAssertTrue(actions.canRelist)
        let warning = actions.relistWarning
        XCTAssertNotNil(warning)
        XCTAssertTrue(warning?.contains("End it yourself") == true, warning ?? "")
    }

    func test_thePlatformSetIsTheDelistSetRatherThanASecondList() {
        // The server derives EXTENSION_REVISE_PLATFORMS and
        // EXTENSION_RELIST_PLATFORMS from EXTENSION_DELIST_PLATFORMS for a
        // stated reason: a second hand-written list of "the extension channels"
        // is how Vinted silently dropped out of a queue once. The phone derives
        // it the same way, and this holds that.
        XCTAssertEqual(ExtensionLifecycle.platforms, PendingDelistService.queueablePlatforms)
        XCTAssertTrue(ExtensionLifecycle.platforms.contains("vinted"))
        XCTAssertTrue(ExtensionLifecycle.platforms.contains("facebook"))
    }

    // MARK: - What the seller reads

    func test_theStaleLabelNamesThePlatformAndTheDate() {
        let since = Date(timeIntervalSince1970: 1_755_000_000)
        let label = ExtensionLifecycle.staleLabel(platform: "poshmark", since: since)
        XCTAssertTrue(label.contains("Poshmark"), label)
        XCTAssertTrue(label.contains("Stale"), label)
    }

    func test_facebookGetsItsRealNameRatherThanACapitalizedId() {
        XCTAssertEqual(ExtensionLifecycle.platformLabel("facebook"), "Facebook Marketplace")
        XCTAssertEqual(ExtensionLifecycle.platformLabel("poshmark"), "Poshmark")
    }

    func test_theQueuedNoticeIsNotSoftened() {
        // One sentence, three surfaces. A queued job is not a done job, and for
        // these channels believing otherwise is how an item sells twice.
        let notice = ExtensionQueueService.queuedNotice
        XCTAssertTrue(notice.contains("Nothing happens on the marketplace"), notice)
    }
}
