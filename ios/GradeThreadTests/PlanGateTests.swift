import XCTest
@testable import GradeThread

/// US-805: plan-gate decoding, soft-warning header parsing, threshold gating,
/// and the centralized ``EdgeAPI`` interception that publishes both signals.
final class PlanGateTests: XCTestCase {

    // MARK: - 402 body decode

    func test_planGateError_decodesCapReached() throws {
        let body = Data(#"""
        {"error":"CAP_REACHED","cap":"activeListings","used":10,"delta":1,"limit":10,"plan":"free","requiredPlan":"starter"}
        """#.utf8)
        let gate = try XCTUnwrap(PlanGateError.decode(from: body))
        XCTAssertEqual(gate.error, "CAP_REACHED")
        XCTAssertEqual(gate.cap, "activeListings")
        XCTAssertEqual(gate.used, 10)
        XCTAssertEqual(gate.limit, 10)
        XCTAssertEqual(gate.plan, "free")
        XCTAssertEqual(gate.requiredPlan, "starter")
        XCTAssertFalse(gate.isFeatureLock)
        XCTAssertEqual(gate.recommendedTierLabel, "Starter")
        XCTAssertEqual(gate.usageDetail, "10 of 10 used this month")
        XCTAssertTrue(gate.title.contains("active-listings"))
        XCTAssertTrue(gate.recommendation.contains("Starter"))
    }

    func test_planGateError_decodesFeatureLocked() throws {
        let body = Data(#"""
        {"error":"FEATURE_LOCKED","feature":"bulkActions","plan":"starter","requiredPlan":"pro"}
        """#.utf8)
        let gate = try XCTUnwrap(PlanGateError.decode(from: body))
        XCTAssertTrue(gate.isFeatureLock)
        XCTAssertEqual(gate.feature, "bulkActions")
        XCTAssertEqual(gate.recommendedTierLabel, "Pro")
        // Feature locks carry no usage numbers.
        XCTAssertNil(gate.usageDetail)
        XCTAssertEqual(gate.title, "That's a paid feature")
    }

    func test_planGateError_rejectsUnrelatedBody() {
        // A normal validation error must NOT be mistaken for a plan gate.
        let body = Data(#"{"error":"validation_failed","detail":"tier required"}"#.utf8)
        XCTAssertNil(PlanGateError.decode(from: body))
    }

    func test_planGateError_isIdentifiableByCap() {
        let a = PlanGateError.decode(from: Data(#"{"error":"CAP_REACHED","cap":"activeListings","limit":10}"#.utf8))
        let b = PlanGateError.decode(from: Data(#"{"error":"CAP_REACHED","cap":"aiActions","limit":50}"#.utf8))
        XCTAssertNotNil(a?.id)
        XCTAssertNotEqual(a?.id, b?.id)
    }

    // MARK: - X-Plan-Warning header parse

    func test_planWarning_parsesHeader() throws {
        let warning = try XCTUnwrap(PlanWarning(header: "CAP_80;kind=activeListings;used=8;limit=10"))
        XCTAssertEqual(warning.kind, "activeListings")
        XCTAssertEqual(warning.used, 8)
        XCTAssertEqual(warning.limit, 10)
        XCTAssertEqual(warning.pct, 0.8, accuracy: 0.0001)
        XCTAssertEqual(warning.pctWhole, 80)
        XCTAssertEqual(warning.capLabel, "active-listings")
    }

    func test_planWarning_rejectsMalformedHeader() {
        XCTAssertNil(PlanWarning(header: "garbage"))
        XCTAssertNil(PlanWarning(header: "CAP_80;kind=activeListings;used=8")) // no limit
        XCTAssertNil(PlanWarning(header: "CAP_80;kind=activeListings;used=x;limit=10")) // non-numeric
    }

    func test_planWarning_pctIsZeroForUnlimited() throws {
        let warning = try XCTUnwrap(PlanWarning(header: "CAP_80;kind=marketplaces;used=3;limit=0"))
        XCTAssertEqual(warning.pct, 0)
    }

    // MARK: - Threshold gating logic

    private func warning(used: Int, limit: Int, kind: String = "activeListings") -> PlanWarning {
        PlanWarning(header: "CAP_80;kind=\(kind);used=\(used);limit=\(limit)")!
    }

    func test_shouldSurface_firesWhenAtOrAboveThreshold() {
        let w = warning(used: 8, limit: 10) // 80%
        XCTAssertTrue(PlanGateNotifier.shouldSurface(warning: w, threshold: .eighty, alreadyWarnedKinds: []))
        XCTAssertTrue(PlanGateNotifier.shouldSurface(warning: w, threshold: .fifty, alreadyWarnedKinds: []))
    }

    func test_shouldSurface_suppressedBelowThreshold() {
        let w = warning(used: 8, limit: 10) // 80%
        // Stricter 95% threshold suppresses an 80% warning.
        XCTAssertFalse(PlanGateNotifier.shouldSurface(warning: w, threshold: .ninetyFive, alreadyWarnedKinds: []))
    }

    func test_shouldSurface_dedupsPerKind() {
        let w = warning(used: 10, limit: 10)
        XCTAssertFalse(
            PlanGateNotifier.shouldSurface(
                warning: w, threshold: .eighty, alreadyWarnedKinds: ["activeListings"]
            )
        )
        // A different cap kind still fires.
        XCTAssertTrue(
            PlanGateNotifier.shouldSurface(
                warning: warning(used: 10, limit: 10, kind: "aiActions"),
                threshold: .eighty,
                alreadyWarnedKinds: ["activeListings"]
            )
        )
    }

    func test_usageAlertThreshold_fractions() {
        XCTAssertEqual(UsageAlertThreshold.fifty.fraction, 0.5)
        XCTAssertEqual(UsageAlertThreshold.eighty.fraction, 0.8)
        XCTAssertEqual(UsageAlertThreshold.ninetyFive.fraction, 0.95)
        XCTAssertEqual(UsageAlertThreshold.allCases.count, 3)
    }

    // MARK: - EdgeAPI centralized interception

    private func makeAPI(
        onGate: @escaping @Sendable (PlanGateError) -> Void = { _ in },
        onWarning: @escaping @Sendable (PlanWarning) -> Void = { _ in }
    ) -> EdgeAPI {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)
        return EdgeAPI(
            baseURL: URL(string: "https://example.test")!,
            session: session,
            tokenProvider: { "tk_test" },
            onPlanGate: onGate,
            onPlanWarning: onWarning
        )
    }

    override func tearDown() {
        MockURLProtocol.handler = nil
        super.tearDown()
    }

    /// A 402 from any call publishes the decoded cap (and still throws so the
    /// caller's flow isn't silently swallowed).
    func test_edgeAPI_publishesPlanGate_on402() async {
        MockURLProtocol.handler = { request in
            (
                HTTPURLResponse(url: request.url!, statusCode: 402, httpVersion: nil, headerFields: nil)!,
                Data(#"{"error":"CAP_REACHED","cap":"includedGrades","used":3,"limit":3,"requiredPlan":"starter"}"#.utf8)
            )
        }
        let box = SignalBox<PlanGateError>()
        let api = makeAPI(onGate: { box.set($0) })
        do {
            let _: WireItem = try await api.getJSON("/api/flipdesk/grade")
            XCTFail("402 should throw")
        } catch {
            // expected — mapped to .badRequest by EdgeAPIError.from
        }
        XCTAssertEqual(box.value?.cap, "includedGrades")
        XCTAssertEqual(box.value?.requiredPlan, "starter")
    }

    /// A successful response carrying the soft-warn header publishes a warning.
    func test_edgeAPI_publishesWarning_onHeader() async throws {
        MockURLProtocol.handler = { request in
            (
                HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: "HTTP/1.1",
                    headerFields: [
                        "Content-Type": "application/json",
                        "X-Plan-Warning": "CAP_80;kind=activeListings;used=8;limit=10",
                    ]
                )!,
                Data(#"{"ok":true}"#.utf8)
            )
        }
        let box = SignalBox<PlanWarning>()
        let api = makeAPI(onWarning: { box.set($0) })
        let _: WireItem = try await api.getJSON("/api/flipdesk/something")
        XCTAssertEqual(box.value?.kind, "activeListings")
        XCTAssertEqual(box.value?.pctWhole, 80)
    }

    func test_edgeAPI_noPlanSignals_onPlainSuccess() async throws {
        MockURLProtocol.handler = { request in
            (
                HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json"]
                )!,
                Data(#"{"ok":true}"#.utf8)
            )
        }
        let gateBox = SignalBox<PlanGateError>()
        let warnBox = SignalBox<PlanWarning>()
        let api = makeAPI(onGate: { gateBox.set($0) }, onWarning: { warnBox.set($0) })
        let _: WireItem = try await api.getJSON("/api/ok")
        XCTAssertNil(gateBox.value)
        XCTAssertNil(warnBox.value)
    }
}

// MARK: - Test helpers

private struct WireItem: Decodable { let ok: Bool? }

/// Thread-safe one-shot capture box for a signal published from the EdgeAPI
/// actor's `@Sendable` observer closure.
private final class SignalBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: T?
    var value: T? {
        lock.lock(); defer { lock.unlock() }
        return _value
    }
    func set(_ newValue: T) {
        lock.lock(); _value = newValue; lock.unlock()
    }
}
