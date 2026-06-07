import XCTest
@testable import GradeThread

/// Decoding the verified-profile payloads (snake_case via the EdgeAPI decoder).
final class VerifiedDecodeTests: XCTestCase {

    func test_decodesProfile_populated() throws {
        let json = #"""
        {"profile":{"handle":"resale-rick","display_name":"Resale Rick",
          "bio":"Vintage tees","enabled":true,
          "verified_since":"2026-01-15T00:00:00.000Z"},
         "stats":{"total_graded":42,"average_grade":7.8}}
        """#
        let r = try JSONDecoder.iso8601.decode(VerifiedProfileResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.profile.handle, "resale-rick")
        XCTAssertEqual(r.profile.displayName, "Resale Rick")
        XCTAssertEqual(r.profile.bio, "Vintage tees")
        XCTAssertTrue(r.profile.enabled)
        XCTAssertEqual(r.profile.verifiedSince, "2026-01-15T00:00:00.000Z")
        XCTAssertEqual(r.stats.totalGraded, 42)
        XCTAssertEqual(r.stats.averageGrade, 7.8, accuracy: 0.001)
    }

    func test_decodesProfile_emptyNulls() throws {
        let json = #"""
        {"profile":{"handle":null,"display_name":null,"bio":null,
          "enabled":false,"verified_since":null},
         "stats":{"total_graded":0,"average_grade":0}}
        """#
        let r = try JSONDecoder.iso8601.decode(VerifiedProfileResponse.self, from: Data(json.utf8))
        XCTAssertNil(r.profile.handle)
        XCTAssertNil(r.profile.displayName)
        XCTAssertFalse(r.profile.enabled)
        XCTAssertNil(r.profile.verifiedSince)
        XCTAssertEqual(r.stats.totalGraded, 0)
        XCTAssertEqual(r.stats.averageGrade, 0, accuracy: 0.001)
    }

    func test_decodesAvailability() throws {
        let ok = try JSONDecoder.iso8601.decode(
            HandleAvailability.self,
            from: Data(#"{"available":true,"handle":"foo","reason":null}"#.utf8))
        XCTAssertTrue(ok.available)
        XCTAssertNil(ok.reason)

        let taken = try JSONDecoder.iso8601.decode(
            HandleAvailability.self,
            from: Data(#"{"available":false,"reason":"That handle is already taken."}"#.utf8))
        XCTAssertFalse(taken.available)
        XCTAssertEqual(taken.reason, "That handle is already taken.")
    }

    func test_decodesUpdateResponse() throws {
        let json = #"{"profile":{"handle":"rick","display_name":"Rick","bio":null,"enabled":true,"verified_since":"2026-06-06T00:00:00Z"}}"#
        let r = try JSONDecoder.iso8601.decode(VerifiedProfileUpdateResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.profile.handle, "rick")
        XCTAssertTrue(r.profile.enabled)
    }

    func test_updateBody_omitsNilKeys() throws {
        // Only `bio` set → encoded JSON contains `bio`, not handle/display_name/enabled.
        var body = VerifiedProfileUpdate()
        body.bio = "Hello"
        let data = try JSONEncoder.iso8601.encode(body)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["bio"] as? String, "Hello")
        XCTAssertNil(obj["handle"])
        XCTAssertNil(obj["display_name"])
        XCTAssertNil(obj["enabled"])
    }
}
