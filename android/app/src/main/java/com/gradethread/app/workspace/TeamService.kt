package com.gradethread.app.workspace

import com.gradethread.app.platform.net.EdgeApi
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.postgrest.from
import io.github.jan.supabase.postgrest.query.Columns
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-2407: the four workspace-membership WRITES, all through the edge.
 *
 * **Every mutation goes through the edge and none of them writes
 * `workspace_members` directly.** RLS would allow an owner to do it from the
 * client, and iOS does exactly that — but the edge is where the role cap, the
 * last-admin guard and the audit log live, so a direct write silently skips
 * all three. An owner who demoted themselves from the phone could lock the
 * workspace out of its own admin functions with nothing recorded.
 *
 * Reads live in [TeamDirectory]: they are RLS-scoped Supabase queries with no
 * edge route behind them, and keeping them apart is what lets these four be
 * tested against a real HTTP server.
 */
interface TeamManaging {
    suspend fun invite(email: String, role: WorkspaceRole): CreatedInvitation

    suspend fun resend(invitationId: String): ResentInvitation

    suspend fun updateRole(memberId: String, role: WorkspaceRole)

    suspend fun remove(memberId: String)
}

@Singleton
class TeamService @Inject constructor(
    /** The shared profile: these are small writes, not vision calls. */
    @Named("shared") private val edge: EdgeApi,
) : TeamManaging {

    override suspend fun invite(email: String, role: WorkspaceRole): CreatedInvitation {
        val payload = json.encodeToString(
            InviteRequest.serializer(),
            // Normalised here as well as on the server so the pending list the
            // owner sees back matches what they will have to type to find it.
            InviteRequest(WorkspaceEmail.normalize(email), role.wire),
        )
        return json.decodeFromString(CreatedInvitation.serializer(), edge.postRaw(INVITATIONS, payload))
    }

    override suspend fun resend(invitationId: String): ResentInvitation =
        json.decodeFromString(
            ResentInvitation.serializer(),
            edge.postRaw("$INVITATIONS/$invitationId/resend", "{}"),
        )

    override suspend fun updateRole(memberId: String, role: WorkspaceRole) {
        val payload = json.encodeToString(RoleRequest.serializer(), RoleRequest(role.wire))
        edge.patchRaw("$MEMBERS/$memberId/role", payload)
    }

    override suspend fun remove(memberId: String) {
        edge.postRaw("$MEMBERS/$memberId/remove", "{}")
    }

    companion object {
        const val INVITATIONS = "/api/workspace/invitations"
        const val MEMBERS = "/api/workspace/members"
        private val json = Json { ignoreUnknownKeys = true; isLenient = true }
    }
}

@Serializable
private data class InviteRequest(val email: String, val role: String)

@Serializable
private data class RoleRequest(val role: String)

/**
 * US-2407: the membership READS, and the one write with no edge route.
 *
 * `workspace_members` and `workspace_invitations` have no list endpoint at all
 * — web and iOS both read them straight from Supabase under RLS, and this
 * follows them rather than inventing a third source.
 *
 * **The invitations table is OWNER-ONLY under RLS.** An admin can create and
 * resend an invitation through the edge but cannot list or revoke one, so
 * [invitations] returns empty for them rather than failing. The screen shows
 * the pending card to the owner only, so an admin is never left looking at an
 * empty list wondering where their invitation went.
 */
interface TeamReading {
    suspend fun members(ownerId: String): List<WorkspaceMemberRow>

    suspend fun invitations(ownerId: String): List<WorkspaceInvitationRow>

    /** Owner-only, per RLS. Throws so the caller can report the refusal. */
    suspend fun revoke(invitationId: String, atIso: String)
}

@Singleton
class TeamDirectory @Inject constructor(
    private val client: SupabaseClient,
) : TeamReading {

    override suspend fun members(ownerId: String): List<WorkspaceMemberRow> =
        client.from("workspace_members")
            .select(
                Columns.raw("id, member_id, role, created_at, users:member_id(id, email, full_name)"),
            ) {
                filter { eq("owner_id", ownerId) }
            }
            .decodeList()

    override suspend fun invitations(ownerId: String): List<WorkspaceInvitationRow> =
        // Everything, not just the pending ones: the state is derived from
        // three stamps (Team.state) and filtering server-side would mean
        // encoding that rule twice, in two languages.
        client.from("workspace_invitations")
            .select(
                Columns.raw("id, email, role, token, created_at, expires_at, accepted_at, revoked_at"),
            ) {
                filter { eq("owner_id", ownerId) }
            }
            .decodeList()

    override suspend fun revoke(invitationId: String, atIso: String) {
        client.from("workspace_invitations")
            .update(mapOf("revoked_at" to atIso)) {
                filter { eq("id", invitationId) }
            }
    }
}
