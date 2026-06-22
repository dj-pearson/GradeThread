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

    func test_aiSession_resourceCeilingAlsoRaised() {
        // The call makes no incremental progress, so the overall-resource ceiling
        // must be raised too (not just the idle timeout).
        XCTAssertGreaterThanOrEqual(
            EdgeNetwork.aiSession.configuration.timeoutIntervalForResource, 90
        )
    }
}
