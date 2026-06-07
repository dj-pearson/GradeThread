import SwiftUI

/// View-model for the Team screen. Manages the caller's OWN workspace: lists
/// members + active invitations, invites/resends/revokes, and changes/removes
/// member roles. Mirrors the other @MainActor @Observable stores.
@MainActor
@Observable
final class TeamStore {

    enum Phase: Equatable {
        case idle
        case loading
        case ready
        case failed(String)
    }

    private let service: TeamProviding

    /// The workspace owner — the signed-in user (v1 manages only your own team).
    let ownerId: String

    var phase: Phase = .idle
    private(set) var members: [WorkspaceMember] = []
    private(set) var invitations: [WorkspaceInvitation] = []   // active only

    // Invite form
    var inviteEmail = ""
    var inviteRole: WorkspaceRole = .member
    var isInviting = false
    var inviteError: String?
    /// Set after a successful invite — drives the "share this link" banner.
    var lastInvite: CreateInviteResponse?

    /// Surfaced by row actions (role change / remove / revoke / resend) on failure.
    var actionError: String?

    init(ownerId: String, service: TeamProviding = TeamService()) {
        self.ownerId = ownerId
        self.service = service
    }

    // MARK: - Derived

    var canInvite: Bool { !isInviting && WorkspaceEmail.isValid(inviteEmail) }

    /// Public accept URL for the most recent invite (banner fallback).
    var lastInviteURL: URL? {
        guard let raw = lastInvite?.acceptUrl else { return nil }
        return URL(string: raw)
    }

    func acceptURL(for invitation: WorkspaceInvitation) -> URL? {
        URL(string: "\(CertificateLink.siteOrigin.absoluteString)/accept-invite?token=\(invitation.token)")
    }

    // MARK: - Load

    func load() async {
        phase = .loading
        do {
            async let membersTask = service.members(ownerId: ownerId)
            async let invitesTask = service.invitations(ownerId: ownerId)
            members = try await membersTask
            invitations = WorkspaceInvites.active(try await invitesTask, now: Date())
            phase = .ready
        } catch {
            phase = .failed(message(error))
        }
    }

    // MARK: - Invite

    @discardableResult
    func invite() async -> Bool {
        let email = inviteEmail.trimmed
        guard WorkspaceEmail.isValid(email) else {
            inviteError = "Enter a valid email address."
            return false
        }
        isInviting = true
        inviteError = nil
        defer { isInviting = false }
        do {
            let res = try await service.invite(email: email, role: inviteRole)
            lastInvite = res
            inviteEmail = ""
            await reloadInvitations()
            return true
        } catch {
            inviteError = message(error)
            return false
        }
    }

    /// Returns whether the email was (re)sent; nil on failure.
    @discardableResult
    func resend(_ invitationId: String) async -> Bool? {
        do {
            let res = try await service.resend(invitationId: invitationId)
            return res.emailSent
        } catch {
            actionError = message(error)
            return nil
        }
    }

    func revoke(_ invitationId: String) async {
        do {
            try await service.revoke(invitationId: invitationId)
            await reloadInvitations()
        } catch {
            actionError = message(error)
        }
    }

    // MARK: - Members

    func updateRole(memberId: String, to role: WorkspaceRole) async {
        do {
            try await service.updateRole(ownerId: ownerId, memberId: memberId, role: role)
            await reloadMembers()
        } catch {
            actionError = message(error)
            await reloadMembers()   // re-sync the picker to server truth
        }
    }

    func remove(memberId: String) async {
        do {
            try await service.remove(ownerId: ownerId, memberId: memberId)
            await reloadMembers()
        } catch {
            actionError = message(error)
        }
    }

    // MARK: - Helpers

    private func reloadMembers() async {
        if let rows = try? await service.members(ownerId: ownerId) {
            members = rows
        }
    }

    private func reloadInvitations() async {
        if let rows = try? await service.invitations(ownerId: ownerId) {
            invitations = WorkspaceInvites.active(rows, now: Date())
        }
    }

    private func message(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
