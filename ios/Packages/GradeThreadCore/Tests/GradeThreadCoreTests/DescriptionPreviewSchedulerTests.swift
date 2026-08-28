import XCTest
@testable import GradeThreadCore

/// US-2964: the two properties the preview scheduler exists for, tested
/// directly. Mirrors src/lib/__tests__/description-preview.test.ts.
final class DescriptionPreviewSchedulerTests: XCTestCase {

    /// A small actor box, because the callbacks are `@Sendable` and a plain
    /// captured `var` would be a data race rather than a counter.
    private actor Recorder {
        private(set) var results: [String] = []
        private(set) var calls: [String] = []
        private(set) var pending: [Bool] = []

        func recordCall(_ value: String) { calls.append(value) }
        func recordResult(_ value: String) { results.append(value) }
        func recordPending(_ value: Bool) { pending.append(value) }
    }

    /// Typing fires ONE request, not one per keystroke.
    func test_debounce_collapsesRapidRequestsIntoOne() async throws {
        let recorder = Recorder()
        let scheduler = DescriptionPreviewScheduler<String, String>(
            delayMilliseconds: 40,
            fetcher: { payload in
                await recorder.recordCall(payload)
                return payload.uppercased()
            },
            onResult: { await recorder.recordResult($0) }
        )

        await scheduler.request("a")
        await scheduler.request("ab")
        await scheduler.request("abc")
        try await Task.sleep(nanoseconds: 300_000_000)

        let calls = await recorder.calls
        let results = await recorder.results
        XCTAssertEqual(calls, ["abc"])
        XCTAssertEqual(results, ["ABC"])
    }

    /// The one that matters. A slow EARLIER render landing after a fast LATER
    /// one would put stale bytes under a seller who is about to publish them.
    func test_lastRequestWins_whenAnEarlierRenderSettlesLast() async throws {
        let recorder = Recorder()
        let scheduler = DescriptionPreviewScheduler<String, String>(
            delayMilliseconds: 10,
            fetcher: { payload in
                // "slow" takes long enough to land after "fast" has already
                // been delivered.
                if payload == "slow" {
                    try await Task.sleep(nanoseconds: 250_000_000)
                }
                return payload
            },
            onResult: { await recorder.recordResult($0) }
        )

        await scheduler.request("slow")
        try await Task.sleep(nanoseconds: 60_000_000) // let the slow fetch start
        await scheduler.request("fast")
        try await Task.sleep(nanoseconds: 500_000_000)

        let results = await recorder.results
        XCTAssertEqual(results, ["fast"])
    }

    /// Cancelling orphans everything in flight, so a screen going away cannot
    /// write into dead state.
    func test_cancel_dropsThePendingRequestAndTheOneInFlight() async throws {
        let recorder = Recorder()
        let scheduler = DescriptionPreviewScheduler<String, String>(
            delayMilliseconds: 10,
            fetcher: { payload in
                try await Task.sleep(nanoseconds: 150_000_000)
                return payload
            },
            onResult: { await recorder.recordResult($0) }
        )

        await scheduler.request("one")
        try await Task.sleep(nanoseconds: 60_000_000) // in flight now
        await scheduler.cancel()
        try await Task.sleep(nanoseconds: 400_000_000)

        let results = await recorder.results
        XCTAssertTrue(results.isEmpty)
    }

    func test_pendingIsRaisedForTheRequestAndLoweredWhenItSettles() async throws {
        let recorder = Recorder()
        let scheduler = DescriptionPreviewScheduler<String, String>(
            delayMilliseconds: 10,
            fetcher: { $0 },
            onResult: { _ in },
            onPending: { await recorder.recordPending($0) }
        )

        await scheduler.request("x")
        try await Task.sleep(nanoseconds: 300_000_000)

        let pending = await recorder.pending
        XCTAssertEqual(pending, [true, false])
    }
}
