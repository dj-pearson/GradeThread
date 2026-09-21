import XCTest
@testable import GradeThread

/// US-3454: the phone reads "what is this item doing on this marketplace" the
/// way the web does (src/lib/channel-state.ts), most urgent first.
@MainActor
final class ChannelStateTests: XCTestCase {

    private func row(_ platform: String, _ status: String, url: String? = nil, delistRequested: Bool = false) -> ChannelRow {
        ChannelRow(id: "row-\(platform)", platform: platform, status: status, url: url, delistRequested: delistRequested)
    }

    private func job(_ kind: String, _ platform: String, status: String, created: String = "2026-09-21T10:00:00Z") -> ExtensionQueueService.QueueItem {
        let json = """
        {"id":"job-\(kind)-\(platform)-\(status)","kind":"\(kind)","platform":"\(platform)","status":"\(status)","source":"ios","created_at":"\(created)","expires_at":"2026-09-30T00:00:00Z","result":null,"inventory_item_id":"item-1","listing_id":null}
        """
        // A decode failure is a test failure; the fixture is the route's own shape.
        return (try? JSONDecoder().decode(ExtensionQueueService.QueueItem.self, from: Data(json.utf8)))
            ?? ExtensionQueueService.QueueItem(
                id: "bad", kind: kind, platform: platform, status: status, source: "ios",
                createdAt: created, expiresAt: "", result: nil, inventoryItemId: nil, listingId: nil
            )
    }

    func test_precedenceMirrorsTheWeb() {
        XCTAssertEqual(ChannelState.precedence, [
            "delist_queued", "queued", "live", "unconfirmed", "failed", "sold", "ended", "prefilled", "none",
        ])
    }

    func test_aDelistInFlightBeatsALiveRow() {
        let s = ChannelStateDerivation.derive(
            rows: [row("poshmark", "active", url: "https://poshmark.com/listing/1")],
            queue: [job("delist", "poshmark", status: "queued")],
            platform: "poshmark"
        )
        XCTAssertEqual(s.state, .delistQueued)
        XCTAssertEqual(s.url, "https://poshmark.com/listing/1")
        XCTAssertTrue(s.state.blocksPush)
    }

    func test_anEndedRowStillStampedIsEnding() {
        let s = ChannelStateDerivation.derive(
            rows: [row("mercari", "ended", delistRequested: true)],
            queue: [],
            platform: "mercari"
        )
        XCTAssertEqual(s.state, .delistQueued)
    }

    func test_aQueuedListBeatsADraftRow_andAFailedOneReadsNeedsYou() {
        let queued = ChannelStateDerivation.derive(
            rows: [row("poshmark", "draft")],
            queue: [job("list", "poshmark", status: "queued")],
            platform: "poshmark"
        )
        XCTAssertEqual(queued.state, .queued)
        XCTAssertEqual(queued.queueStatus, "queued")

        let failed = ChannelStateDerivation.derive(
            rows: [row("poshmark", "draft")],
            queue: [job("list", "poshmark", status: "failed")],
            platform: "poshmark"
        )
        XCTAssertEqual(failed.state, .failed)
        XCTAssertFalse(failed.state.blocksPush)
    }

    func test_theRowsOwnStatusOtherwise() {
        XCTAssertEqual(ChannelStateDerivation.derive(rows: [row("ebay", "active")], queue: [], platform: "ebay").state, .live)
        XCTAssertEqual(ChannelStateDerivation.derive(rows: [row("ebay", "relisted")], queue: [], platform: "ebay").state, .live)
        XCTAssertEqual(ChannelStateDerivation.derive(rows: [row("ebay", "sold")], queue: [], platform: "ebay").state, .sold)
        XCTAssertEqual(ChannelStateDerivation.derive(rows: [row("ebay", "ended")], queue: [], platform: "ebay").state, .ended)
        XCTAssertEqual(ChannelStateDerivation.derive(rows: [row("ebay", "draft")], queue: [], platform: "ebay").state, .prefilled)
        XCTAssertEqual(ChannelStateDerivation.derive(rows: [], queue: [], platform: "vinted").state, .none)
    }

    func test_anotherPlatformsJobIsNotMine() {
        let s = ChannelStateDerivation.derive(
            rows: [row("mercari", "draft")],
            queue: [job("list", "poshmark", status: "queued")],
            platform: "mercari"
        )
        XCTAssertEqual(s.state, .prefilled)
    }

    func test_theNewestJobWins() {
        let s = ChannelStateDerivation.derive(
            rows: [],
            queue: [
                job("list", "poshmark", status: "failed", created: "2026-09-21T09:00:00Z"),
                job("list", "poshmark", status: "queued", created: "2026-09-21T11:00:00Z"),
            ],
            platform: "poshmark"
        )
        XCTAssertEqual(s.state, .queued)
    }
}
