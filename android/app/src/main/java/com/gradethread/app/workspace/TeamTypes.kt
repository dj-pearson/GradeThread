package com.gradethread.app.workspace

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * US-2407: the workspace role vocabulary and the invitation rules.
 *
 * Mirrors `src/lib/workspace-permissions.ts` and the edge's
 * `lib/workspace-roles.ts`. Pure, so the parts that decide what an owner is
 * allowed to see and do are provable without a server or a Compose harness.
 */
enum class WorkspaceRole(val wire: String, val rank: Int) {
    VIEWER("viewer", 1),
    MEMBER("member", 2),
    LISTING_MANAGER("listing_manager", 3),
    ADMIN("admin", 4),
    OWNER("owner", 5),
    ;

    /**
     * Whether this role may invite, re-role and remove people.
     *
     * Admin and above, matching the edge — every mutating workspace route
     * checks `roleAtLeast(role, "admin")`. The screen hides the affordances
     * below that rather than offering buttons the server will refuse.
     */
    val canManageMembers: Boolean get() = rank >= ADMIN.rank

    companion object {
        /**
         * The roles that can be GIVEN. `owner` is missing on purpose: it is not
         * a `workspace_members` row at all, it is whoever the workspace belongs
         * to, so there is nothing to assign.
         */
        val assignable: List<WorkspaceRole> = listOf(ADMIN, LISTING_MANAGER, MEMBER, VIEWER)

        /** Unknown wire values fall back to the least powerful role — a new
         *  server role must never be silently treated as an admin. */
        fun from(wire: String?): WorkspaceRole =
            entries.firstOrNull { it.wire == wire } ?: VIEWER
    }
}

@Serializable
data class WorkspaceUserLite(
    val id: String = "",
    val email: String? = null,
    @SerialName("full_name") val fullName: String? = null,
)

@Serializable
data class WorkspaceMemberRow(
    val id: String = "",
    @SerialName("member_id") val memberId: String = "",
    val role: String = "",
    @SerialName("created_at") val createdAt: String? = null,
    val users: WorkspaceUserLite? = null,
)

@Serializable
data class WorkspaceInvitationRow(
    val id: String = "",
    val email: String = "",
    val role: String = "",
    val token: String = "",
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("expires_at") val expiresAt: String? = null,
    @SerialName("accepted_at") val acceptedAt: String? = null,
    @SerialName("revoked_at") val revokedAt: String? = null,
)

@Serializable
data class CreatedInvitation(
    val id: String = "",
    val email: String = "",
    val role: String = "",
    @SerialName("accept_url") val acceptUrl: String = "",
    /**
     * The server sends the invitation email itself and reports whether it
     * left. It is best-effort by design, so `false` is a normal 200 and the
     * screen has to offer the link by hand instead of claiming success.
     */
    @SerialName("email_sent") val emailSent: Boolean = false,
)

@Serializable
data class ResentInvitation(
    @SerialName("email_sent") val emailSent: Boolean = false,
    @SerialName("accept_url") val acceptUrl: String = "",
)

/**
 * One row on the members list.
 *
 * The owner is not a `workspace_members` row, so the screen synthesises one —
 * see [Team.roster]. [isOwner] is what keeps the role picker and the remove
 * button off it.
 */
data class TeamMember(
    val memberId: String,
    val role: WorkspaceRole,
    val name: String?,
    val email: String?,
    val isOwner: Boolean = false,
)

/** What a pending invitation is doing, derived from three nullable stamps. */
enum class InvitationState { PENDING, ACCEPTED, REVOKED, EXPIRED }

object Team {

    /**
     * The state of an invitation.
     *
     * There is no `status` column: `workspace_invitations` carries
     * `accepted_at`, `revoked_at` and `expires_at`, and the answer is whichever
     * happened. Order matters — an invitation that was accepted and has since
     * passed its expiry is ACCEPTED, not EXPIRED, and reporting the latter
     * would tell an owner a teammate never joined.
     */
    fun state(row: WorkspaceInvitationRow, nowMillis: Long): InvitationState = when {
        !row.acceptedAt.isNullOrBlank() -> InvitationState.ACCEPTED
        !row.revokedAt.isNullOrBlank() -> InvitationState.REVOKED
        expired(row.expiresAt, nowMillis) -> InvitationState.EXPIRED
        else -> InvitationState.PENDING
    }

    /**
     * An unparseable or missing expiry is NOT treated as expired.
     *
     * The remedy for a stale invitation is resend, and the server checks the
     * real expiry anyway. Calling a row expired because the phone could not
     * read a timestamp would hide a live invitation from the only person who
     * can act on it.
     */
    private fun expired(expiresAt: String?, nowMillis: Long): Boolean {
        val at = WorkspaceDate.parse(expiresAt) ?: return false
        return at <= nowMillis
    }

    /** Invitations still worth showing: pending first, newest first. */
    fun open(rows: List<WorkspaceInvitationRow>, nowMillis: Long): List<WorkspaceInvitationRow> =
        rows.filter { state(it, nowMillis) == InvitationState.PENDING }
            .sortedByDescending { WorkspaceDate.parse(it.createdAt) ?: 0L }

    /**
     * The members list as the screen renders it.
     *
     * The owner is prepended as a synthetic row because they own the workspace
     * rather than belonging to it — there is no `workspace_members` row to read
     * and no role to change. Everyone else follows in join order, which is the
     * order the list was in the last time the owner looked at it.
     */
    fun roster(
        ownerId: String,
        ownerName: String?,
        ownerEmail: String?,
        rows: List<WorkspaceMemberRow>,
    ): List<TeamMember> {
        val owner = TeamMember(
            memberId = ownerId,
            role = WorkspaceRole.OWNER,
            name = ownerName,
            email = ownerEmail,
            isOwner = true,
        )
        val others = rows
            // Defensive: an owner who also holds a member row would otherwise
            // appear twice, once removable.
            .filterNot { it.memberId == ownerId }
            .sortedBy { WorkspaceDate.parse(it.createdAt) ?: 0L }
            .map {
                TeamMember(
                    memberId = it.memberId,
                    role = WorkspaceRole.from(it.role),
                    name = it.users?.fullName,
                    email = it.users?.email,
                )
            }
        return listOf(owner) + others
    }

    /**
     * Whether [actor] may act on [target].
     *
     * Mirrors the edge's guard so the UI does not offer a button that is
     * certain to come back 403: you cannot touch someone at or above your own
     * role, and nobody can touch the owner.
     */
    fun canAct(actor: WorkspaceRole, target: TeamMember): Boolean =
        actor.canManageMembers && !target.isOwner && actor.rank > target.role.rank

    /** The roles [actor] may hand out — never one above their own. */
    fun assignableBy(actor: WorkspaceRole): List<WorkspaceRole> =
        WorkspaceRole.assignable.filter { it.rank <= actor.rank }
}

object WorkspaceEmail {
    /**
     * The same shape the edge accepts — a trimmed address with an `@` in it.
     *
     * Deliberately not a stricter pattern: the server is the authority on what
     * it will take, and a client regex that refuses a valid address the server
     * would have accepted is a bug the seller cannot work around.
     */
    fun isValid(raw: String): Boolean {
        val text = raw.trim()
        return text.contains("@") && text.length >= 3 && !text.contains(" ")
    }

    fun normalize(raw: String): String = raw.trim().lowercase()
}

object WorkspaceDate {
    /**
     * Parse an ISO-8601 timestamp to epoch millis, or null.
     *
     * Postgres hands back both `2026-08-11T00:00:00+00:00` and
     * `2026-08-11T00:00:00Z`, sometimes with fractional seconds, so this goes
     * through the lenient parser rather than a fixed pattern.
     */
    fun parse(raw: String?): Long? {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return null
        return runCatching { java.time.Instant.parse(text).toEpochMilli() }.getOrNull()
            ?: runCatching {
                java.time.OffsetDateTime.parse(text).toInstant().toEpochMilli()
            }.getOrNull()
    }

    /** Whole days from [nowMillis] until [raw], floored at 0; null if unknown. */
    fun daysUntil(raw: String?, nowMillis: Long): Long? {
        val at = parse(raw) ?: return null
        return ((at - nowMillis).coerceAtLeast(0L)) / 86_400_000L
    }
}
