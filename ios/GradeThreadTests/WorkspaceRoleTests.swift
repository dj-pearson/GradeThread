import XCTest
@testable import GradeThread

/// Pure workspace logic: role mapping, email validation, invitation filtering.
final class WorkspaceRoleTests: XCTestCase {

    func test_role_rawValues() {
        XCTAssertEqual(WorkspaceRole.listingManager.rawValue, "listing_manager")
        XCTAssertEqual(WorkspaceRole.admin.rawValue, "admin")
    }

    func test_role_decodesFromString() throws {
        let r = try JSONDecoder().decode(WorkspaceRole.self, from: Data(#""listing_manager""#.utf8))
        XCTAssertEqual(r, .listingManager)
    }

    func test_assignable_excludesOwner() {
        XCTAssertEqual(WorkspaceRole.assignable, [.admin, .listingManager, .member, .viewer])
        XCTAssertFalse(WorkspaceRole.assignable.contains(.owner))
    }

    func test_labels() {
        XCTAssertEqual(WorkspaceRole.owner.label, "Owner")
        XCTAssertEqual(WorkspaceRole.listingManager.label, "Manager")
        XCTAssertEqual(WorkspaceRole.member.label, "Staff")
    }

    func test_email_validation() {
        XCTAssertTrue(WorkspaceEmail.isValid("a@b.com"))
        XCTAssertTrue(WorkspaceEmail.isValid("  teammate@shop.co  "))
        XCTAssertFalse(WorkspaceEmail.isValid("nope"))
        XCTAssertFalse(WorkspaceEmail.isValid("a@b"))
        XCTAssertFalse(WorkspaceEmail.isValid("a b@c.com"))
        XCTAssertFalse(WorkspaceEmail.isValid(""))
    }

    func test_invites_active_filtersAcceptedRevokedExpired() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let iso = ISO8601DateFormatter()
        let future = iso.string(from: now.addingTimeInterval(86_400))
        let past = iso.string(from: now.addingTimeInterval(-86_400))

        func inv(_ id: String, expires: String, accepted: String? = nil, revoked: String? = nil) -> WorkspaceInvitation {
            WorkspaceInvitation(id: id, email: "\(id)@x.com", role: .member, token: "t-\(id)",
                                expiresAt: expires, acceptedAt: accepted, revokedAt: revoked)
        }

        let rows = [
            inv("active", expires: future),
            inv("accepted", expires: future, accepted: past),
            inv("revoked", expires: future, revoked: past),
            inv("expired", expires: past),
        ]
        let active = WorkspaceInvites.active(rows, now: now)
        XCTAssertEqual(active.map(\.id), ["active"])
    }
}
