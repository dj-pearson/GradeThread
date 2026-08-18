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

    /// The active workspace owner — whose team this screen manages. May be a
    /// shared workspace the caller was invited to, not necessarily themselves.
    let ownerId: String

    /// The signed-in user's id, used to resolve the caller's OWN role in this
    /// workspace (owner of `ownerId`, or their `workspace_members` row).
    let selfId: String

    /// The caller's resolved role in this workspace. Drives whether write
    /// controls (invite / role pickers / remove / revoke) are shown. Starts at
    /// the most restrictive role until membership is known, so writes stay
    /// hidden until the caller's role is proven.
    private(set) var currentRole: WorkspaceRole = .viewer

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

    // MARK: - US-2532: workspace MFA policy

    /// The threshold at/above which members must use 2FA. `nil` = enforcement off.
    private(set) var mfaPolicy: WorkspaceRole?
    /// ⚠ A FAILED READ IS NOT "OFF". US-2185 made exactly this point on web: a
    /// GET that fails must not render "Not required", because that reads as an
    /// explicit, safe setting when the real policy is unknown. This flag makes
    /// the view show a retry instead of a value it does not have.
    private(set) var mfaLoadFailed = false
    var mfaSaving = false

    init(ownerId: String, selfId: String, service: TeamProviding = TeamService()) {
        self.ownerId = ownerId
        self.selfId = selfId
        self.service = service
        // The owner's own role is known immediately; a member's resolves on load.
        self.currentRole = ownerId == selfId ? .owner : .viewer
    }

    // MARK: - Derived

    /// True when the caller is the workspace owner (full access, can't be removed).
    var isOwner: Bool { selfId == ownerId }

    /// Whether the caller may manage members — invite, change roles, remove,
    /// revoke. Owner + admin only (mirrors the web `manage_members` capability).
    var canManageMembers: Bool { currentRole.canManageMembers }

    /// Members to list — excludes the caller, who is rendered as the synthetic
    /// "You" row, so they aren't shown twice in a shared workspace.
    var otherMembers: [WorkspaceMember] {
        members.filter { $0.memberId != selfId }
    }

    var canInvite: Bool { canManageMembers && !isInviting && WorkspaceEmail.isValid(inviteEmail) }

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
            currentRole = resolveCurrentRole()
            invitations = WorkspaceInvites.active(try await invitesTask, now: Date())
            phase = .ready
            // US-2532: owner/admin only — the edge 403s anyone else, and asking
            // would surface an error for a control they cannot see anyway.
            if canManageMembers { await loadMfaPolicy() }
        } catch {
            phase = .failed(message(error))
        }
    }

    // MARK: - Invite

    @discardableResult
    func invite() async -> Bool {
        guard canManageMembers else {
            inviteError = "You don't have permission to invite members."
            return false
        }
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
        guard canManageMembers else { return nil }
        do {
            let res = try await service.resend(invitationId: invitationId)
            return res.emailSent
        } catch {
            actionError = message(error)
            return nil
        }
    }

    func revoke(_ invitationId: String) async {
        guard canManageMembers else { return }
        do {
            try await service.revoke(invitationId: invitationId)
            await reloadInvitations()
        } catch {
            actionError = message(error)
        }
    }

    // MARK: - Members

    func updateRole(memberId: String, to role: WorkspaceRole) async {
        guard canManageMembers else { return }
        do {
            try await service.updateRole(ownerId: ownerId, memberId: memberId, role: role)
            await reloadMembers()
        } catch {
            actionError = message(error)
            await reloadMembers()   // re-sync the picker to server truth
        }
    }

    func remove(memberId: String) async {
        guard canManageMembers else { return }
        do {
            try await service.remove(ownerId: ownerId, memberId: memberId)
            await reloadMembers()
        } catch {
            actionError = message(error)
        }
    }

    // MARK: - Helpers

    /// The caller's role in this workspace: owner if they own it, else their
    /// `workspace_members` row, else the most restrictive (`viewer`).
    private func resolveCurrentRole() -> WorkspaceRole {
        if selfId == ownerId { return .owner }
        return members.first { $0.memberId == selfId }?.role ?? .viewer
    }

    private func reloadMembers() async {
        // US-1498: surface a failed post-mutation refresh via actionError (the
        // UI's error banner) instead of swallowing it with `try?` — otherwise a
        // removed member could silently stay listed against server truth.
        do {
            members = try await service.members(ownerId: ownerId)
            currentRole = resolveCurrentRole()
        } catch {
            actionError = message(error)
        }
    }

    private func reloadInvitations() async {
        do {
            invitations = WorkspaceInvites.active(
                try await service.invitations(ownerId: ownerId), now: Date())
        } catch {
            actionError = message(error)
        }
    }

    private func message(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
    // MARK: - US-2532: MFA policy

    func loadMfaPolicy() async {
        mfaLoadFailed = false
        do {
            mfaPolicy = try await service.mfaPolicy()
        } catch {
            // Deliberately does NOT fall back to nil-means-off. See mfaLoadFailed.
            mfaLoadFailed = true
        }
    }

    /// Owner-only in practice; the EDGE enforces it and this only hides the
    /// control. On failure the previous value is restored, so the picker never
    /// shows a policy the server did not accept.
    func setMfaPolicy(_ role: WorkspaceRole?) async {
        let previous = mfaPolicy
        mfaSaving = true
        defer { mfaSaving = false }
        mfaPolicy = role
        do {
            mfaPolicy = try await service.setMfaPolicy(role)
        } catch {
            mfaPolicy = previous
            actionError = message(error)
        }
    }

}
