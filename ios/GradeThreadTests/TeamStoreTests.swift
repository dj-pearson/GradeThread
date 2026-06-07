import XCTest
@testable import GradeThread

/// `TeamStore` load + invite/resend/role/remove/revoke flows (in-memory service).
@MainActor
final class TeamStoreTests: XCTestCase {

    private func member(_ id: String, role: WorkspaceRole = .member) -> WorkspaceMember {
        WorkspaceMember(id: "row-\(id)", memberId: id, email: "\(id)@x.com",
                        name: nil, role: role, createdAt: "2026-01-01T00:00:00Z")
    }

    private func invite(_ id: String, expires: String, accepted: String? = nil, revoked: String? = nil) -> WorkspaceInvitation {
        WorkspaceInvitation(id: id, email: "\(id)@x.com", role: .member, token: "t-\(id)",
                            expiresAt: expires, acceptedAt: accepted, revokedAt: revoked)
    }

    private func sampleInviteResponse(email: String = "x@y.com") -> CreateInviteResponse {
        CreateInviteResponse(id: "i9", email: email, role: .member, token: "tok",
                             acceptUrl: "https://gradethread.com/accept-invite?token=tok",
                             emailSent: true)
    }

    func test_load_populatesAndFiltersInvites() async {
        let future = ISO8601DateFormatter().string(from: Date().addingTimeInterval(86_400))
        let past = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-86_400))
        let fake = FakeTeamService()
        fake.membersResult = .success([member("a"), member("b")])
        fake.invitationsResult = .success([
            invite("active", expires: future),
            invite("revoked", expires: future, revoked: past),
        ])
        let store = TeamStore(ownerId: "o1", service: fake)
        await store.load()

        XCTAssertEqual(store.phase, .ready)
        XCTAssertEqual(store.members.count, 2)
        XCTAssertEqual(store.invitations.map(\.id), ["active"])
    }

    func test_load_failed() async {
        let fake = FakeTeamService()
        fake.membersResult = .failure(EdgeAPIError.network("offline"))
        let store = TeamStore(ownerId: "o1", service: fake)
        await store.load()
        if case .failed = store.phase {} else { XCTFail("expected .failed") }
    }

    func test_canInvite_validation() {
        let store = TeamStore(ownerId: "o1", service: FakeTeamService())
        store.inviteEmail = "nope"
        XCTAssertFalse(store.canInvite)
        store.inviteEmail = "teammate@shop.co"
        XCTAssertTrue(store.canInvite)
    }

    func test_invite_success() async {
        let fake = FakeTeamService()
        fake.inviteResult = .success(sampleInviteResponse(email: "teammate@shop.co"))
        let store = TeamStore(ownerId: "o1", service: fake)
        store.inviteEmail = "teammate@shop.co"
        store.inviteRole = .admin

        let ok = await store.invite()
        XCTAssertTrue(ok)
        XCTAssertEqual(fake.invitedEmail, "teammate@shop.co")
        XCTAssertEqual(fake.invitedRole, .admin)
        XCTAssertNotNil(store.lastInvite)
        XCTAssertEqual(store.inviteEmail, "")
        XCTAssertNotNil(store.lastInviteURL)
    }

    func test_invite_invalidEmail_doesNotCallService() async {
        let fake = FakeTeamService()
        let store = TeamStore(ownerId: "o1", service: fake)
        store.inviteEmail = "bad"
        let ok = await store.invite()
        XCTAssertFalse(ok)
        XCTAssertNotNil(store.inviteError)
        XCTAssertNil(fake.invitedEmail)
    }

    func test_invite_error() async {
        let fake = FakeTeamService()
        fake.inviteResult = .failure(EdgeAPIError.badRequest(detail: "Upgrade to invite members."))
        let store = TeamStore(ownerId: "o1", service: fake)
        store.inviteEmail = "teammate@shop.co"
        let ok = await store.invite()
        XCTAssertFalse(ok)
        XCTAssertNotNil(store.inviteError)
    }

    func test_updateRole_callsServiceAndReloads() async {
        let fake = FakeTeamService()
        fake.membersResult = .success([member("a")])
        let store = TeamStore(ownerId: "o1", service: fake)
        await store.load()
        let callsAfterLoad = fake.membersCalls

        await store.updateRole(memberId: "a", to: .admin)
        XCTAssertEqual(fake.updatedRole?.memberId, "a")
        XCTAssertEqual(fake.updatedRole?.role, .admin)
        XCTAssertEqual(fake.membersCalls, callsAfterLoad + 1) // reloaded
    }

    func test_remove_callsService() async {
        let fake = FakeTeamService()
        let store = TeamStore(ownerId: "o1", service: fake)
        await store.remove(memberId: "a")
        XCTAssertEqual(fake.removedMemberId, "a")
    }

    func test_revoke_callsServiceAndReloads() async {
        let fake = FakeTeamService()
        let store = TeamStore(ownerId: "o1", service: fake)
        await store.revoke("i1")
        XCTAssertEqual(fake.revokedId, "i1")
    }

    func test_resend_returnsEmailSent() async {
        let fake = FakeTeamService()
        fake.resendResult = .success(ResendInviteResponse(emailSent: true, acceptUrl: "https://x"))
        let store = TeamStore(ownerId: "o1", service: fake)
        let sent = await store.resend("i1")
        XCTAssertEqual(sent, true)
        XCTAssertEqual(fake.resentId, "i1")
    }
}

private final class FakeTeamService: TeamProviding {
    var membersResult: Result<[WorkspaceMember], Error> = .success([])
    var invitationsResult: Result<[WorkspaceInvitation], Error> = .success([])
    var inviteResult: Result<CreateInviteResponse, Error> =
        .success(CreateInviteResponse(id: "i", email: "x@y.com", role: .member, token: "t",
                                      acceptUrl: "https://x", emailSent: true))
    var resendResult: Result<ResendInviteResponse, Error> =
        .success(ResendInviteResponse(emailSent: true, acceptUrl: "https://x"))
    var updateRoleError: Error?
    var removeError: Error?
    var revokeError: Error?

    private(set) var membersCalls = 0
    private(set) var invitedEmail: String?
    private(set) var invitedRole: WorkspaceRole?
    private(set) var updatedRole: (memberId: String, role: WorkspaceRole)?
    private(set) var removedMemberId: String?
    private(set) var revokedId: String?
    private(set) var resentId: String?

    func members(ownerId: String) async throws -> [WorkspaceMember] {
        membersCalls += 1
        return try membersResult.get()
    }

    func invitations(ownerId: String) async throws -> [WorkspaceInvitation] {
        try invitationsResult.get()
    }

    func invite(email: String, role: WorkspaceRole) async throws -> CreateInviteResponse {
        invitedEmail = email
        invitedRole = role
        return try inviteResult.get()
    }

    func resend(invitationId: String) async throws -> ResendInviteResponse {
        resentId = invitationId
        return try resendResult.get()
    }

    func updateRole(ownerId: String, memberId: String, role: WorkspaceRole) async throws {
        if let updateRoleError { throw updateRoleError }
        updatedRole = (memberId, role)
    }

    func remove(ownerId: String, memberId: String) async throws {
        if let removeError { throw removeError }
        removedMemberId = memberId
    }

    func revoke(invitationId: String) async throws {
        if let revokeError { throw revokeError }
        revokedId = invitationId
    }
}
