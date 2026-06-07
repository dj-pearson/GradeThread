import XCTest
@testable import GradeThread

/// Decoding the team payloads. Supabase rows use plain JSONDecoder() (explicit
/// CodingKeys); edge responses use the convertFromSnakeCase decoder.
final class TeamDecodeTests: XCTestCase {

    func test_decodesMemberRow() throws {
        let json = #"""
        {"id":"m1","owner_id":"o1","member_id":"u2","role":"admin",
         "invited_by":null,"created_at":"2026-01-01T00:00:00Z",
         "updated_at":"2026-01-02T00:00:00Z"}
        """#
        let row = try JSONDecoder().decode(WorkspaceMemberRow.self, from: Data(json.utf8))
        XCTAssertEqual(row.id, "m1")
        XCTAssertEqual(row.ownerId, "o1")
        XCTAssertEqual(row.memberId, "u2")
        XCTAssertEqual(row.role, .admin)
        XCTAssertEqual(row.createdAt, "2026-01-01T00:00:00Z")
    }

    func test_decodesUserLite() throws {
        let row = try JSONDecoder().decode(
            WorkspaceUserLite.self,
            from: Data(#"{"id":"u2","email":"a@b.com","full_name":"Al"}"#.utf8))
        XCTAssertEqual(row.email, "a@b.com")
        XCTAssertEqual(row.fullName, "Al")
    }

    func test_decodesInvitationRow() throws {
        let json = #"""
        {"id":"i1","email":"x@y.com","role":"listing_manager","token":"tok",
         "expires_at":"2026-02-01T00:00:00Z","accepted_at":null,"revoked_at":null}
        """#
        let inv = try JSONDecoder().decode(WorkspaceInvitation.self, from: Data(json.utf8))
        XCTAssertEqual(inv.id, "i1")
        XCTAssertEqual(inv.role, .listingManager)
        XCTAssertEqual(inv.token, "tok")
        XCTAssertNil(inv.acceptedAt)
        XCTAssertNil(inv.revokedAt)
    }

    func test_decodesCreateInviteResponse_edge() throws {
        let json = #"""
        {"id":"i1","token":"tok","email":"x@y.com","role":"viewer",
         "expires_at":"2026-02-01T00:00:00Z",
         "accept_url":"https://gradethread.com/accept-invite?token=tok",
         "email_sent":true}
        """#
        let res = try JSONDecoder.iso8601.decode(CreateInviteResponse.self, from: Data(json.utf8))
        XCTAssertEqual(res.role, .viewer)
        XCTAssertEqual(res.acceptUrl, "https://gradethread.com/accept-invite?token=tok")
        XCTAssertTrue(res.emailSent)
    }

    func test_decodesResendResponse_edge() throws {
        let res = try JSONDecoder.iso8601.decode(
            ResendInviteResponse.self,
            from: Data(#"{"email_sent":false,"accept_url":"https://x/accept-invite?token=t"}"#.utf8))
        XCTAssertFalse(res.emailSent)
        XCTAssertEqual(res.acceptUrl, "https://x/accept-invite?token=t")
    }
}
