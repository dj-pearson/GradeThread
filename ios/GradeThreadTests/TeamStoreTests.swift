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
        let store = TeamStore(ownerId: "o1", selfId: "o1", service: fake)
        await store.load()

        XCTAssertEqual(store.phase, .ready)
        XCTAssertEqual(store.members.count, 2)
        XCTAssertEqual(store.invitations.map(\.id), ["active"])
    }

    func test_load_failed() async {
        let fake = FakeTeamService()
        fake.membersResult = .failure(EdgeAPIError.network("offline"))
        let store = TeamStore(ownerId: "o1", selfId: "o1", service: fake)
        await store.load()
        if case .failed = store.phase {} else { XCTFail("expected .failed") }
    }

    func test_canInvite_validation() {
        let store = TeamStore(ownerId: "o1", selfId: "o1", service: FakeTeamService())
        store.inviteEmail = "nope"
        XCTAssertFalse(store.canInvite)
        store.inviteEmail = "teammate@shop.co"
        XCTAssertTrue(store.canInvite)
    }

    func test_invite_success() async {
        let fake = FakeTeamService()
        fake.inviteResult = .success(sampleInviteResponse(email: "teammate@shop.co"))
        let store = TeamStore(ownerId: "o1", selfId: "o1", service: fake)
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
        let store = TeamStore(ownerId: "o1", selfId: "o1", service: fake)
        store.inviteEmail = "bad"
        let ok = await store.invite()
        XCTAssertFalse(ok)
        XCTAssertNotNil(store.inviteError)
        XCTAssertNil(fake.invitedEmail)
    }

    func test_invite_error() async {
        let fake = FakeTeamService()
        fake.inviteResult = .failure(EdgeAPIError.badRequest(detail: "Upgrade to invite members."))
        let store = TeamStore(ownerId: "o1", selfId: "o1", service: fake)
        store.inviteEmail = "teammate@shop.co"
        let ok = await store.invite()
        XCTAssertFalse(ok)
        XCTAssertNotNil(store.inviteError)
    }

    func test_updateRole_callsServiceAndReloads() async {
        let fake = FakeTeamService()
        fake.membersResult = .success([member("a")])
        let store = TeamStore(ownerId: "o1", selfId: "o1", service: fake)
        await store.load()
        let callsAfterLoad = fake.membersCalls

        await store.updateRole(memberId: "a", to: .admin)
        XCTAssertEqual(fake.updatedRole?.memberId, "a")
        XCTAssertEqual(fake.updatedRole?.role, .admin)
        XCTAssertEqual(fake.membersCalls, callsAfterLoad + 1) // reloaded
    }

    func test_remove_callsService() async {
        let fake = FakeTeamService()
        let store = TeamStore(ownerId: "o1", selfId: "o1", service: fake)
        await store.remove(memberId: "a")
        XCTAssertEqual(fake.removedMemberId, "a")
    }

    func test_revoke_callsServiceAndReloads() async {
        let fake = FakeTeamService()
        let store = TeamStore(ownerId: "o1", selfId: "o1", service: fake)
        await store.revoke("i1")
        XCTAssertEqual(fake.revokedId, "i1")
    }

    func test_resend_returnsEmailSent() async {
        let fake = FakeTeamService()
        fake.resendResult = .success(ResendInviteResponse(emailSent: true, acceptUrl: "https://x"))
        let store = TeamStore(ownerId: "o1", selfId: "o1", service: fake)
        let sent = await store.resend("i1")
        XCTAssertEqual(sent, true)
        XCTAssertEqual(fake.resentId, "i1")
    }

    // MARK: - US-1254: role scoping + write gating

    func test_owner_hasOwnerRole_andCanManage() {
        let store = TeamStore(ownerId: "o1", selfId: "o1", service: FakeTeamService())
        XCTAssertTrue(store.isOwner)
        XCTAssertEqual(store.currentRole, .owner)
        XCTAssertTrue(store.canManageMembers)
    }

    func test_member_roleResolvedFromMembership_excludesSelfFromList() async {
        let fake = FakeTeamService()
        fake.membersResult = .success([member("u2", role: .member), member("a", role: .viewer)])
        // Caller u2 operates inside o1's shared workspace as a member.
        let store = TeamStore(ownerId: "o1", selfId: "u2", service: fake)
        XCTAssertFalse(store.isOwner)
        await store.load()

        XCTAssertEqual(store.currentRole, .member)
        XCTAssertFalse(store.canManageMembers)
        // The caller is rendered as the synthetic "You" row, not the roster.
        XCTAssertEqual(store.otherMembers.map(\.memberId), ["a"])
    }

    func test_admin_canManage() async {
        let fake = FakeTeamService()
        fake.membersResult = .success([member("u3", role: .admin)])
        let store = TeamStore(ownerId: "o1", selfId: "u3", service: fake)
        await store.load()
        XCTAssertEqual(store.currentRole, .admin)
        XCTAssertTrue(store.canManageMembers)
    }

    func test_nonManager_writesAreNoOps() async {
        let fake = FakeTeamService()
        fake.membersResult = .success([member("u2", role: .member)])
        let store = TeamStore(ownerId: "o1", selfId: "u2", service: fake)
        await store.load()
        XCTAssertFalse(store.canManageMembers)

        store.inviteEmail = "teammate@shop.co"
        XCTAssertFalse(store.canInvite)
        let invited = await store.invite()
        XCTAssertFalse(invited)
        XCTAssertNil(fake.invitedEmail)

        await store.updateRole(memberId: "a", to: .admin)
        XCTAssertNil(fake.updatedRole)

        await store.remove(memberId: "a")
        XCTAssertNil(fake.removedMemberId)

        await store.revoke("i1")
        XCTAssertNil(fake.revokedId)

        let resent = await store.resend("i1")
        XCTAssertNil(resent)
        XCTAssertNil(fake.resentId)
    }
    // MARK: - US-2532: workspace MFA policy

    func test_mfaPolicy_loadsForAManager() async {
        let fake = FakeTeamService()
        fake.membersResult = .success([member("owner", role: .owner)])
        fake.mfaPolicyResult = .success(.admin)
        let store = TeamStore(ownerId: "owner", selfId: "owner", service: fake)

        await store.load()

        XCTAssertEqual(store.mfaPolicy, .admin)
        XCTAssertFalse(store.mfaLoadFailed)
        XCTAssertEqual(fake.mfaPolicyCalls, 1)
    }

    func test_mfaPolicy_failedReadIsNotTreatedAsOff() async {
        // The load-bearing case. A GET that fails must NOT leave the store
        // showing "not required" — that reads as an explicit, safe setting when
        // the real policy is unknown, on a security control. US-2185 made the
        // same point on web.
        let fake = FakeTeamService()
        fake.membersResult = .success([member("owner", role: .owner)])
        fake.mfaPolicyResult = .failure(URLError(.timedOut))
        let store = TeamStore(ownerId: "owner", selfId: "owner", service: fake)

        await store.load()

        XCTAssertTrue(store.mfaLoadFailed, "a failed read must be distinguishable from 'off'")
        XCTAssertNil(store.mfaPolicy)
        // The rest of the screen still loaded — one failed control does not fail
        // the Team page.
        XCTAssertEqual(store.phase, .ready)
    }

    func test_mfaPolicy_isNotFetchedForAMemberWhoCannotManage() async {
        // The edge 403s a non-manager, so asking would surface an error for a
        // control they never see.
        let fake = FakeTeamService()
        fake.membersResult = .success([member("owner", role: .owner), member("me", role: .member)])
        let store = TeamStore(ownerId: "owner", selfId: "me", service: fake)

        await store.load()

        XCTAssertEqual(fake.mfaPolicyCalls, 0)
    }

    func test_setMfaPolicy_restoresThePreviousValueWhenTheSaveFails() async {
        // Otherwise the picker sits on a policy the server refused, which is the
        // worst possible state for a security control: it LOOKS applied.
        let fake = FakeTeamService()
        fake.membersResult = .success([member("owner", role: .owner)])
        fake.mfaPolicyResult = .success(.admin)
        let store = TeamStore(ownerId: "owner", selfId: "owner", service: fake)
        await store.load()

        fake.setMfaPolicyError = URLError(.badServerResponse)
        await store.setMfaPolicy(.viewer)

        XCTAssertEqual(store.mfaPolicy, .admin, "a refused save must not stick")
        XCTAssertNotNil(store.actionError)
    }

    func test_setMfaPolicy_sendsNilToClearRatherThanASentinel() async {
        let fake = FakeTeamService()
        fake.membersResult = .success([member("owner", role: .owner)])
        fake.mfaPolicyResult = .success(.admin)
        let store = TeamStore(ownerId: "owner", selfId: "owner", service: fake)
        await store.load()

        await store.setMfaPolicy(nil)

        XCTAssertEqual(fake.setMfaPolicyTo, .some(nil), "clearing sends null, never a role named 'off'")
        XCTAssertNil(store.mfaPolicy)
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
    // US-2532: the MFA policy. Result rather than a bare value so a test can
    // drive the FAILED read — which is the case that matters, because the store
    // must not fall back to "not required" when it cannot tell.
    var mfaPolicyResult: Result<WorkspaceRole?, Error> = .success(nil)
    var setMfaPolicyError: Error?

    private(set) var membersCalls = 0
    private(set) var invitedEmail: String?
    private(set) var invitedRole: WorkspaceRole?
    private(set) var updatedRole: (memberId: String, role: WorkspaceRole)?
    private(set) var removedMemberId: String?
    private(set) var revokedId: String?
    private(set) var resentId: String?
    private(set) var mfaPolicyCalls = 0
    private(set) var setMfaPolicyTo: WorkspaceRole??

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

    func mfaPolicy() async throws -> WorkspaceRole? {
        mfaPolicyCalls += 1
        return try mfaPolicyResult.get()
    }

    @discardableResult
    func setMfaPolicy(_ role: WorkspaceRole?) async throws -> WorkspaceRole? {
        if let setMfaPolicyError { throw setMfaPolicyError }
        setMfaPolicyTo = role
        return role
    }

}
