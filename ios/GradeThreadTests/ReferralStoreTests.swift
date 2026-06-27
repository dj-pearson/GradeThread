import XCTest
@testable import GradeThread

/// `ReferralsStore` derived state + load/redeem flows (in-memory service).
@MainActor
final class ReferralStoreTests: XCTestCase {

    private func makeMe(
        code: String = "ABCD2345",
        total: Int = 0, pending: Int = 0, qualified: Int = 0, granted: Int = 0,
        referredBy: ReferredBy? = nil
    ) -> ReferralMe {
        ReferralMe(
            code: code,
            stats: ReferralStats(total: total, pending: pending, qualified: qualified, granted: granted),
            referredBy: referredBy
        )
    }

    func test_referralURL_format() {
        let store = ReferralsStore(service: FakeReferralService(me: makeMe()))
        store.me = makeMe(code: "ABCD2345")
        XCTAssertEqual(store.referralURL?.absoluteString,
                       "https://gradethread.com/signup?ref=ABCD2345")
    }

    func test_referralURL_nilWithoutCode() {
        let store = ReferralsStore(service: FakeReferralService(me: makeMe()))
        XCTAssertNil(store.referralURL) // me not loaded
    }

    func test_inProgress_isTotalMinusGranted() {
        // US-1255: derived from total − granted so the columns reconcile.
        let store = ReferralsStore(service: FakeReferralService(me: makeMe()))
        store.me = makeMe(total: 5, pending: 1, qualified: 2, granted: 2)
        XCTAssertEqual(store.inProgress, 3) // 5 − 2
    }

    func test_statColumns_reconcile() {
        // Referred == In progress + Rewarded, by construction.
        let store = ReferralsStore(service: FakeReferralService(me: makeMe()))
        store.me = makeMe(total: 7, pending: 3, qualified: 1, granted: 2)
        let stats = store.me!.stats
        XCTAssertEqual(stats.total, store.inProgress + stats.granted)
    }

    func test_inProgress_clampsNegativeToZero() {
        // A granted count that somehow exceeds total never shows a negative.
        let store = ReferralsStore(service: FakeReferralService(me: makeMe()))
        store.me = makeMe(total: 1, granted: 3)
        XCTAssertEqual(store.inProgress, 0)
    }

    func test_redeem_mapsReasonToSpecificCopy() async {
        let cases: [(reason: String, expected: String)] = [
            ("self_referral", RedeemRejection.message(for: "self_referral")),
            ("already_referred", RedeemRejection.message(for: "already_referred")),
            ("invalid_code", RedeemRejection.message(for: "invalid_code")),
            ("expired", RedeemRejection.message(for: "expired")),
        ]
        for c in cases {
            let store = ReferralsStore(
                service: FakeReferralService(
                    me: makeMe(),
                    redeem: .success(RedeemResponse(ok: false, reason: c.reason)))
            )
            store.redeemCode = "FRND12"
            let ok = await store.redeem()
            XCTAssertFalse(ok)
            XCTAssertEqual(store.redeemError, c.expected)
            XCTAssertFalse(store.redeemSucceeded)
            // Each reason maps to a distinct, non-generic message.
            XCTAssertNotEqual(store.redeemError, RedeemRejection.generic)
        }
    }

    func test_redeem_unknownReasonFallsBackToGeneric() async {
        let store = ReferralsStore(
            service: FakeReferralService(
                me: makeMe(),
                redeem: .success(RedeemResponse(ok: false, reason: "something_new")))
        )
        store.redeemCode = "FRND12"
        let ok = await store.redeem()
        XCTAssertFalse(ok)
        XCTAssertEqual(store.redeemError, RedeemRejection.generic)
    }

    func test_redeemRejection_mappingIsExhaustiveAndDistinct() {
        // Pure mapper: each known reason yields specific, distinct copy.
        let reasons = ["invalid_code", "self_referral", "already_referred",
                       "expired", "account_suspended", "missing_code"]
        let messages = reasons.map { RedeemRejection.message(for: $0) }
        XCTAssertEqual(Set(messages).count, reasons.count) // all distinct
        for m in messages { XCTAssertNotEqual(m, RedeemRejection.generic) }
        XCTAssertEqual(RedeemRejection.message(for: nil), RedeemRejection.generic)
    }

    func test_load_setsReadyAndMe() async {
        let store = ReferralsStore(service: FakeReferralService(me: makeMe(code: "Z9")))
        await store.load()
        XCTAssertEqual(store.phase, .ready)
        XCTAssertEqual(store.me?.code, "Z9")
    }

    func test_load_failedSurfacesError() async {
        let store = ReferralsStore(service: FakeReferralService(me: makeMe(), meError: EdgeAPIError.network("offline")))
        await store.load()
        if case .failed = store.phase {} else { XCTFail("expected .failed phase") }
    }

    func test_redeem_successReloadsAndFlags() async {
        let before = makeMe(referredBy: nil)
        let after = makeMe(referredBy: ReferredBy(status: "pending", code: "FRND12"))
        let store = ReferralsStore(
            service: FakeReferralService(meSequence: [before, after], redeem: .success(RedeemResponse(ok: true)))
        )
        await store.load()        // me = before (not yet referred)
        store.redeemCode = "frnd12"
        let ok = await store.redeem()
        XCTAssertTrue(ok)
        XCTAssertTrue(store.redeemSucceeded)
        XCTAssertTrue(store.alreadyReferred) // reloaded → after
        XCTAssertEqual(store.redeemCode, "")
    }

    func test_redeem_errorSurfaces() async {
        let store = ReferralsStore(
            service: FakeReferralService(me: makeMe(),
                redeem: .failure(EdgeAPIError.badRequest(detail: "You can't redeem your own code.")))
        )
        store.redeemCode = "ABCD2345"
        let ok = await store.redeem()
        XCTAssertFalse(ok)
        XCTAssertNotNil(store.redeemError)
        XCTAssertFalse(store.redeemSucceeded)
    }

    func test_canRedeem_falseWhenAlreadyReferred() {
        let store = ReferralsStore(service: FakeReferralService(me: makeMe()))
        store.me = makeMe(referredBy: ReferredBy(status: "pending", code: "X"))
        store.redeemCode = "ABCD"
        XCTAssertFalse(store.canRedeem)
    }
}

private final class FakeReferralService: ReferralProviding {
    private let meQueue: [ReferralMe]
    private let meError: Error?
    private let redeemResult: Result<RedeemResponse, Error>
    private(set) var meCalls = 0

    init(me: ReferralMe, meError: Error? = nil,
         redeem: Result<RedeemResponse, Error> = .success(RedeemResponse(ok: true))) {
        self.meQueue = [me]; self.meError = meError; self.redeemResult = redeem
    }
    init(meSequence: [ReferralMe], redeem: Result<RedeemResponse, Error>) {
        self.meQueue = meSequence; self.meError = nil; self.redeemResult = redeem
    }

    func me() async throws -> ReferralMe {
        if let meError { throw meError }
        let i = min(meCalls, meQueue.count - 1)
        meCalls += 1
        return meQueue[i]
    }

    func redeem(code: String) async throws -> RedeemResponse {
        switch redeemResult {
        case .success(let r): return r
        case .failure(let e): throw e
        }
    }
}
