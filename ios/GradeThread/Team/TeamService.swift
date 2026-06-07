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
        let now = ISO8601DateFormatter().string(from: Date())
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
}
