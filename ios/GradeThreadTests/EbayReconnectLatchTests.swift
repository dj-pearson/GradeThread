import XCTest
@testable import GradeThread

/// US-1262: the one-shot latch that bridges a "reconnect eBay" deep link to the
/// Marketplaces surface must fire OAuth exactly once — `consume()` returns true
/// at most once per `request()` so the cold-mount `.task` and the live
/// `.onReceive` can't both start a duplicate connection flow.
@MainActor
final class EbayReconnectLatchTests: XCTestCase {

    func test_consume_isFalse_withoutRequest() {
        let latch = EbayReconnectLatch.shared
        // Drain any state a prior test may have left on the singleton.
        _ = latch.consume()
        XCTAssertFalse(latch.consume())
    }

    func test_request_thenConsume_isTrueExactlyOnce() {
        let latch = EbayReconnectLatch.shared
        _ = latch.consume()
        latch.request()
        XCTAssertTrue(latch.consume(), "First consume after request fires")
        XCTAssertFalse(latch.consume(), "Second consume is a no-op until the next request")
    }
}
