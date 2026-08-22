import XCTest
@testable import GradeThread

/// Guards the AI-inference session's idle timeout. Regression target: AI extract
/// (with its eBay-aspects second model pass) does ~20-40s of server-side work
/// and streams nothing until the JSON lands, so the short 20s idle timeout on
/// the shared edge session falsely timed it out and surfaced "AI couldn't read
/// these photos" on requests that had actually succeeded server-side.
final class EdgeNetworkTests: XCTestCase {

    func test_aiSession_hasGenerousIdleTimeout() {
        // Must comfortably exceed the ~40s one-call extract happy path.
        XCTAssertGreaterThanOrEqual(
            EdgeNetwork.aiSession.configuration.timeoutIntervalForRequest, 90
        )
    }

    func test_aiSession_idleTimeoutBeatsSharedEdgeSession() {
        // The whole point: AI calls need a far longer idle ceiling than the
        // 20s-idle shared edge session used for normal request/response traffic.
        XCTAssertGreaterThan(
            EdgeNetwork.aiSession.configuration.timeoutIntervalForRequest,
            EdgeNetwork.shared.configuration.timeoutIntervalForRequest
        )
    }

    // The eBay lifecycle session. Same shape as the AI one, different reason:
    // the edge makes several eBay calls in a row and returns nothing until the
    // last lands, and it allows 20s PER CALL. The client used to give up at 20s
    // total, inside a window the server is designed to survive - and because a
    // publish is not idempotent, that false failure invited a retry that can
    // list one item twice.
    func test_marketplaceSession_outlastsASingleSlowEbayHop() {
        // EBAY_TIMEOUT_MS in the edge's ebay-client is 20s per hop, and a publish
        // makes about five. Anything at or under one hop is no protection at all.
        XCTAssertGreaterThan(
            EdgeNetwork.marketplaceSession.configuration.timeoutIntervalForRequest, 60
        )
    }

    func test_marketplaceSession_beatsTheSharedEdgeSession() {
        XCTAssertGreaterThan(
            EdgeNetwork.marketplaceSession.configuration.timeoutIntervalForRequest,
            EdgeNetwork.shared.configuration.timeoutIntervalForRequest
        )
    }

    func test_marketplaceSession_resourceCeilingExceedsItsIdleCeiling() {
        // A publish that is still making progress must not be cut off by the
        // overall ceiling before the idle one has had its say.
        let config = EdgeNetwork.marketplaceSession.configuration
        XCTAssertGreaterThan(
            config.timeoutIntervalForResource, config.timeoutIntervalForRequest
        )
    }

    func test_aiSession_resourceCeilingAlsoRaised() {
        // The call makes no incremental progress, so the overall-resource ceiling
        // must be raised too (not just the idle timeout).
        XCTAssertGreaterThanOrEqual(
            EdgeNetwork.aiSession.configuration.timeoutIntervalForResource, 90
        )
    }
}
