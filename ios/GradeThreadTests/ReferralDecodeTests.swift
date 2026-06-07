import XCTest
@testable import GradeThread

/// Decoding the referrals payloads (snake_case via the EdgeAPI decoder).
final class ReferralDecodeTests: XCTestCase {

    func test_decodesMe_withReferredBy() throws {
        let json = #"""
        {"code":"ABCD2345",
         "stats":{"total":5,"pending":1,"qualified":2,"granted":2},
         "referred_by":{"status":"granted","code":"XYZW9876"}}
        """#
        let m = try JSONDecoder.iso8601.decode(ReferralMe.self, from: Data(json.utf8))
        XCTAssertEqual(m.code, "ABCD2345")
        XCTAssertEqual(m.stats.total, 5)
        XCTAssertEqual(m.stats.granted, 2)
        XCTAssertEqual(m.referredBy?.code, "XYZW9876")
        XCTAssertEqual(m.referredBy?.status, "granted")
    }

    func test_decodesMe_nullReferredBy() throws {
        let json = #"{"code":"AAAA1111","stats":{"total":0,"pending":0,"qualified":0,"granted":0},"referred_by":null}"#
        let m = try JSONDecoder.iso8601.decode(ReferralMe.self, from: Data(json.utf8))
        XCTAssertEqual(m.code, "AAAA1111")
        XCTAssertNil(m.referredBy)
    }

    func test_decodesRedeem() throws {
        let r = try JSONDecoder.iso8601.decode(RedeemResponse.self, from: Data(#"{"ok":true}"#.utf8))
        XCTAssertTrue(r.ok)
    }
}
