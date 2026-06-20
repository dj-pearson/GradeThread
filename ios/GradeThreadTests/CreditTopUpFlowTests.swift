import XCTest
@testable import GradeThread

/// US-809: the in-flow credit top-up poll/re-validate state machine. Drives
/// `CreditTopUpFlow` with a scripted balance feed + a no-op sleep so the poll
/// cadence, grant detection, timeout, and re-validate hand-off are all asserted
/// without StoreKit/Supabase.
@MainActor
final class CreditTopUpFlowTests: XCTestCase {

    /// Scripts the billing-snapshot balance per poll and records cadence. Once
    /// the script is exhausted it repeats the last value (a balance that never
    /// changes = the grant never lands).
    private final class Probe {
        private let balances: [Int?]
        private(set) var fetchCount = 0
        private(set) var sleepCount = 0
        private(set) var revalidateCount = 0
        init(_ balances: [Int?]) { self.balances = balances }

        func fetch() -> Int? {
            defer { fetchCount += 1 }
            if fetchCount < balances.count { return balances[fetchCount] }
            return balances.last ?? nil
        }
        func sleep() { sleepCount += 1 }
        func revalidate() { revalidateCount += 1 }
    }

    private func flow(_ probe: Probe, maxPolls: Int = 5) -> CreditTopUpFlow {
        CreditTopUpFlow(
            maxPolls: maxPolls,
            fetchBalance: { probe.fetch() },
            sleep: { _ in probe.sleep() })
    }

    func test_grantOnFirstPoll_isGrantedWithoutSleeping() async {
        let probe = Probe([12])               // balance already reflects the grant
        let f = flow(probe)
        await f.awaitGrant(baseline: 2) { probe.revalidate() }
        XCTAssertEqual(f.state, .granted(12))
        XCTAssertEqual(probe.fetchCount, 1)
        XCTAssertEqual(probe.sleepCount, 0)
        XCTAssertEqual(probe.revalidateCount, 1)
    }

    func test_grantAfterLatency_pollsUntilBalanceIncreases() async {
        let probe = Probe([2, 2, 7])          // grant lands on the 3rd poll
        let f = flow(probe)
        await f.awaitGrant(baseline: 2) { probe.revalidate() }
        XCTAssertEqual(f.state, .granted(7))
        XCTAssertEqual(probe.fetchCount, 3)
        XCTAssertEqual(probe.sleepCount, 2)   // backoff between the three polls
        XCTAssertEqual(probe.revalidateCount, 1)
    }

    func test_timeout_whenGrantNeverLands_leavesRetryAffordanceState() async {
        let probe = Probe([2])                // balance never moves off baseline
        let f = flow(probe, maxPolls: 4)
        await f.awaitGrant(baseline: 2) { probe.revalidate() }
        XCTAssertEqual(f.state, .timedOut)
        XCTAssertEqual(probe.fetchCount, 4)
        XCTAssertEqual(probe.sleepCount, 3)   // no sleep after the final attempt
        XCTAssertEqual(probe.revalidateCount, 1) // re-validate even on timeout
    }

    func test_transientNilFetches_areToleratedThenGrant() async {
        let probe = Probe([nil, nil, 9])      // two failed polls, then the grant
        let f = flow(probe)
        await f.awaitGrant(baseline: 1) { probe.revalidate() }
        XCTAssertEqual(f.state, .granted(9))
        XCTAssertEqual(probe.fetchCount, 3)
    }

    func test_balanceEqualToBaseline_isNotTreatedAsGrant() async {
        // A balance equal to (not greater than) baseline must keep polling —
        // the grant is a strict increase, so an unchanged balance can't unblock.
        let probe = Probe([5])
        let f = flow(probe, maxPolls: 3)
        await f.awaitGrant(baseline: 5) { probe.revalidate() }
        XCTAssertEqual(f.state, .timedOut)
        XCTAssertEqual(probe.fetchCount, 3)
    }

    func test_reset_returnsToIdle() async {
        let probe = Probe([5])
        let f = flow(probe)
        await f.awaitGrant(baseline: 1) { probe.revalidate() }
        XCTAssertEqual(f.state, .granted(5))
        f.reset()
        XCTAssertEqual(f.state, .idle)
    }
}
