import XCTest
@testable import GradeThread

/// US-3452: the delist log's words on the phone mirror `src/lib/delist-log-words.ts`.
final class DelistLogTests: XCTestCase {

    private func event(
        _ kind: String,
        platform: String = "poshmark",
        actor: String = "browser",
        note: String? = nil,
        url: String? = nil
    ) -> PendingDelistService.DelistLogEvent {
        PendingDelistService.DelistLogEvent(
            at: "2026-09-21T14:06:00Z",
            platform: platform,
            listingId: "l1",
            event: kind,
            actor: actor,
            url: url,
            note: note
        )
    }

    func test_soldAndEnded_readClosed() {
        let sold = DelistLogView.line(for: event("sold", platform: "ebay", actor: "server"))
        XCTAssertEqual(sold.headline, "Sold on eBay")
        XCTAssertFalse(sold.open)

        let ended = DelistLogView.line(for: event("ended_extension"))
        XCTAssertEqual(ended.headline, "Poshmark ended")
        XCTAssertTrue(ended.detail.contains("your browser"))
        XCTAssertFalse(ended.open)

        XCTAssertTrue(DelistLogView.line(for: event("ended_by_hand", actor: "seller")).detail.contains("by you"))
    }

    func test_openStates_sayWhatToDo() {
        for kind in ["queued", "waiting", "unresolved"] {
            let line = DelistLogView.line(for: event(kind, platform: "mercari"))
            XCTAssertTrue(line.open, kind)
            XCTAssertTrue(line.headline.contains("Mercari"), kind)
        }
        XCTAssertTrue(DelistLogView.line(for: event("waiting")).detail.contains("End it yourself"))
        XCTAssertTrue(DelistLogView.line(for: event("unresolved", note: "no delist path")).detail.contains("no delist path"))
    }

    func test_eventDecodesSnakeCaseKeys() throws {
        let json = #"{"at":"2026-09-21T14:06:00Z","platform":"grailed","listing_id":"g1","event":"unresolved","actor":"browser","url":"https://www.grailed.com/listings/1","note":"x"}"#
        let decoded = try JSONDecoder().decode(PendingDelistService.DelistLogEvent.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.listingId, "g1")
        XCTAssertEqual(decoded.url, "https://www.grailed.com/listings/1")
    }
}
