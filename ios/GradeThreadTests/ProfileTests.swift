import XCTest
@testable import GradeThread

final class ProfileTests: XCTestCase {

    private func decode(_ json: String) throws -> ProfileStore.Profile {
        try JSONDecoder().decode(ProfileStore.Profile.self, from: Data(json.utf8))
    }

    func test_decodesFullProfile() throws {
        let p = try decode(#"""
        {"id":"u1","email":"a@b.com","full_name":"Dana Reseller","plan":"professional",
         "grades_used_this_month":7,"grade_reset_at":"2026-07-01T00:00:00Z"}
        """#)
        XCTAssertEqual(p.email, "a@b.com")
        XCTAssertEqual(p.fullName, "Dana Reseller")
        XCTAssertEqual(p.plan, "professional")
        XCTAssertEqual(p.planLabel, "Professional")
        XCTAssertEqual(p.gradesUsedThisMonth, 7)
        XCTAssertNotNil(p.resetDate)
    }

    func test_decodesProfile_nullNameAndNoReset() throws {
        let p = try decode(#"""
        {"id":"u2","email":"x@y.com","plan":"free","grades_used_this_month":0}
        """#)
        XCTAssertNil(p.fullName)
        XCTAssertEqual(p.planLabel, "Free")
        XCTAssertEqual(p.gradesUsedThisMonth, 0)
        XCTAssertNil(p.resetDate)
    }

    func test_planLabel_capitalizesEachTier() throws {
        for (raw, expected) in [
            ("free", "Free"), ("starter", "Starter"),
            ("professional", "Professional"), ("enterprise", "Enterprise"),
        ] {
            let p = try decode(#"{"id":"u","email":"e","plan":"\#(raw)","grades_used_this_month":0}"#)
            XCTAssertEqual(p.planLabel, expected)
        }
    }
}
