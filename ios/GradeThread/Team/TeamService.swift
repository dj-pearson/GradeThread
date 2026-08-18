import Foundation
import Supabase

/// Team / workspace edge + DB client. Member reads and role/remove/revoke writes
/// go through the Supabase client (RLS-scoped to the owner). Invite create +
/// resend go through the Hono edge (`/api/workspace/invitations`), which gates on
/// plan + seat capacity. v1 manages the caller's OWN workspace, so `ownerId` is
/// always the signed-in user — no `X-Workspace-Owner` header needed (the edge
/// defaults the tenant to the caller). Behind a protocol so the store is testable.
protocol TeamProviding {
    func members(ownerId: String) async throws -> [WorkspaceMember]
    func invitations(ownerId: String) async throws -> [WorkspaceInvitation]
    func invite(email: String, role: WorkspaceRole) async throws -> CreateInviteResponse
    func resend(invitationId: String) async throws -> ResendInviteResponse
    func updateRole(ownerId: String, memberId: String, role: WorkspaceRole) async throws
    func remove(ownerId: String, memberId: String) async throws
    func revoke(invitationId: String) async throws
    /// US-2532: the workspace MFA threshold. `nil` means enforcement is off.
    /// Owner and admin may READ it; only the owner may write it, and the EDGE is
    /// what enforces that — this client never decides it locally.
    func mfaPolicy() async throws -> WorkspaceRole?
    /// Returns the policy the server stored, so the UI reflects what was
    /// actually saved rather than what was requested.
    @discardableResult
    func setMfaPolicy(_ role: WorkspaceRole?) async throws -> WorkspaceRole?
}

struct TeamService: TeamProviding {
    private let api: EdgeAPI
    private let db: SupabaseClient

    init(api: EdgeAPI = .shared, db: SupabaseClient = SupabaseShared.client) {
        self.api = api
        self.db = db
    }

    // MARK: - Reads (Supabase)

    func members(ownerId: String) async throws -> [WorkspaceMember] {
        let rows: [WorkspaceMemberRow] = try await db
            .from("workspace_members")
            .select("*")
            .eq("owner_id", value: ownerId)
            .order("created_at", ascending: true)
            .execute()
            .value
        guard !rows.isEmpty else { return [] }

        let ids = rows.map(\.memberId)
        let profiles: [WorkspaceUserLite] = try await db
            .from("users")
            .select("id, email, full_name")
            .in("id", values: ids)
            .execute()
            .value
        let byId = Dictionary(profiles.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })

        return rows.map { row in
            let profile = byId[row.memberId]
            return WorkspaceMember(
                id: row.id,
                memberId: row.memberId,
                email: profile?.email ?? "",
                name: profile?.fullName,
                role: row.role,
                createdAt: row.createdAt
            )
        }
    }

    func invitations(ownerId: String) async throws -> [WorkspaceInvitation] {
        try await db
            .from("workspace_invitations")
            .select("*")
            .eq("owner_id", value: ownerId)
            .order("created_at", ascending: false)
            .execute()
            .value
    }

    // MARK: - Writes (Supabase)

    func updateRole(ownerId: String, memberId: String, role: WorkspaceRole) async throws {
        struct RoleUpdate: Encodable { let role: WorkspaceRole }
        try await db
            .from("workspace_members")
            .update(RoleUpdate(role: role))
            .eq("owner_id", value: ownerId)
            .eq("member_id", value: memberId)
            .execute()
    }

    func remove(ownerId: String, memberId: String) async throws {
        try await db
            .from("workspace_members")
            .delete()
            .eq("owner_id", value: ownerId)
            .eq("member_id", value: memberId)
            .execute()
    }

    func revoke(invitationId: String) async throws {
        struct RevokeUpdate: Encodable { let revoked_at: String }
        // US-1256: write fractional-seconds ISO8601 to match the edge's timestamp
        // format (and WorkspaceDate.parse, which prefers fractional) so this
        // client-written value sorts consistently against server timestamps.
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let now = formatter.string(from: Date())
        try await db
            .from("workspace_invitations")
            .update(RevokeUpdate(revoked_at: now))
            .eq("id", value: invitationId)
            .execute()
    }

    // MARK: - Invites (edge)

    func invite(email: String, role: WorkspaceRole) async throws -> CreateInviteResponse {
        struct Body: Encodable { let email: String; let role: WorkspaceRole }
        return try await api.postJSON("/api/workspace/invitations", body: Body(email: email, role: role))
    }

    func resend(invitationId: String) async throws -> ResendInviteResponse {
        struct Empty: Encodable {}
        return try await api.postJSON(
            "/api/workspace/invitations/\(invitationId)/resend", body: Empty())
    }
    /// US-2532: GET /api/workspace/mfa-policy.
    ///
    /// No owner id is sent: the edge resolves the ACTIVE workspace from the
    /// session, and accepting one here would invite a client to ask about a
    /// workspace it is not acting in.
    func mfaPolicy() async throws -> WorkspaceRole? {
        struct Response: Decodable { let required_role: WorkspaceRole? }
        let response: Response = try await api.getJSON("/api/workspace/mfa-policy")
        return response.required_role
    }

    /// US-2532: PUT the threshold. `nil` CLEARS it — the endpoint takes null
    /// rather than a sentinel, so the "Not required" choice must send null and
    /// never the string "off".
    ///
    /// The route echoes the stored value back, so the caller can render what was
    /// saved instead of what it asked for.
    @discardableResult
    func setMfaPolicy(_ role: WorkspaceRole?) async throws -> WorkspaceRole? {
        struct Body: Encodable { let required_role: WorkspaceRole? }
        struct Response: Decodable { let required_role: WorkspaceRole? }
        let response: Response = try await api.putJSON(
            "/api/workspace/mfa-policy",
            body: Body(required_role: role)
        )
        return response.required_role
    }

}
