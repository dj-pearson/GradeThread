package com.gradethread.app.workspace

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-2407: the rules that decide who a phone lets you act on, and what a
 * pending invitation actually is.
 */
class TeamTest {

    private val now = 1_754_870_400_000L // 2025-08-11T00:00:00Z

    private fun invitation(
        id: String = "i1",
        expiresAt: String? = "2025-08-25T00:00:00Z",
        acceptedAt: String? = null,
        revokedAt: String? = null,
        createdAt: String? = "2025-08-11T00:00:00Z",
    ) = WorkspaceInvitationRow(
        id = id,
        email = "$id@example.com",
        role = "member",
        token = "t",
        createdAt = createdAt,
        expiresAt = expiresAt,
        acceptedAt = acceptedAt,
        revokedAt = revokedAt,
    )

    private fun member(id: String, role: String, created: String = "2025-08-01T00:00:00Z") =
        WorkspaceMemberRow(
            id = "row-$id",
            memberId = id,
            role = role,
            createdAt = created,
            users = WorkspaceUserLite(id = id, email = "$id@example.com"),
        )

    // ── roles ────────────────────────────────────────────────────────────

    @Test
    fun `an unknown wire role reads as the least powerful one`() {
        // A role the server adds later must never be mistaken for an admin,
        // which is what a permissive fallback would do.
        assertEquals(WorkspaceRole.VIEWER, WorkspaceRole.from("supervisor"))
        assertEquals(WorkspaceRole.VIEWER, WorkspaceRole.from(null))
        assertEquals(WorkspaceRole.LISTING_MANAGER, WorkspaceRole.from("listing_manager"))
    }

    @Test
    fun `owner is never an assignable role`() {
        assertFalse(WorkspaceRole.OWNER in WorkspaceRole.assignable)
        assertEquals(4, WorkspaceRole.assignable.size)
    }

    @Test
    fun `only admin and above can manage members`() {
        assertTrue(WorkspaceRole.OWNER.canManageMembers)
        assertTrue(WorkspaceRole.ADMIN.canManageMembers)
        assertFalse(WorkspaceRole.LISTING_MANAGER.canManageMembers)
        assertFalse(WorkspaceRole.VIEWER.canManageMembers)
    }

    @Test
    fun `nobody can hand out a role above their own`() {
        assertEquals(WorkspaceRole.assignable, Team.assignableBy(WorkspaceRole.OWNER))
        assertEquals(WorkspaceRole.assignable, Team.assignableBy(WorkspaceRole.ADMIN))
        // A manager cannot manage members at all, but the filter still holds:
        // admin is above them and is not on offer.
        assertFalse(WorkspaceRole.ADMIN in Team.assignableBy(WorkspaceRole.LISTING_MANAGER))
    }

    // ── the roster ───────────────────────────────────────────────────────

    @Test
    fun `the owner is a synthetic first row and cannot be acted on`() {
        val roster = Team.roster("owner-1", "Dj", "dj@example.com", listOf(member("m1", "admin")))
        assertEquals(listOf("owner-1", "m1"), roster.map { it.memberId })
        assertTrue(roster.first().isOwner)
        assertEquals(WorkspaceRole.OWNER, roster.first().role)
        // Even another owner-ranked actor cannot: the workspace belongs to one
        // person and there is no members row to change.
        assertFalse(Team.canAct(WorkspaceRole.OWNER, roster.first()))
    }

    @Test
    fun `an owner who also holds a member row appears once`() {
        val roster = Team.roster(
            "owner-1", null, null,
            listOf(member("owner-1", "admin"), member("m1", "viewer")),
        )
        assertEquals(listOf("owner-1", "m1"), roster.map { it.memberId })
        assertTrue(roster.first().isOwner)
    }

    @Test
    fun `members follow in join order, not in whatever order the rows arrived`() {
        val roster = Team.roster(
            "owner-1", null, null,
            listOf(
                member("late", "member", "2025-08-05T00:00:00Z"),
                member("early", "member", "2025-07-01T00:00:00Z"),
            ),
        )
        assertEquals(listOf("owner-1", "early", "late"), roster.map { it.memberId })
    }

    @Test
    fun `you cannot act on someone at or above your own role`() {
        val roster = Team.roster("owner-1", null, null, listOf(member("a", "admin"), member("v", "viewer")))
        val admin = roster.first { it.memberId == "a" }
        val viewer = roster.first { it.memberId == "v" }

        assertFalse(Team.canAct(WorkspaceRole.ADMIN, admin))
        assertTrue(Team.canAct(WorkspaceRole.ADMIN, viewer))
        assertTrue(Team.canAct(WorkspaceRole.OWNER, admin))
        // A manager is below the bar entirely, so the list is read-only.
        assertFalse(Team.canAct(WorkspaceRole.LISTING_MANAGER, viewer))
    }

    // ── invitation state ─────────────────────────────────────────────────

    @Test
    fun `an accepted invitation reads as accepted even after its expiry passed`() {
        val row = invitation(expiresAt = "2025-07-01T00:00:00Z", acceptedAt = "2025-06-20T00:00:00Z")
        // Reporting EXPIRED here would tell an owner a teammate never joined.
        assertEquals(InvitationState.ACCEPTED, Team.state(row, now))
    }

    @Test
    fun `revoked beats expired, and both beat pending`() {
        assertEquals(
            InvitationState.REVOKED,
            Team.state(invitation(expiresAt = "2025-07-01T00:00:00Z", revokedAt = "2025-06-30T00:00:00Z"), now),
        )
        assertEquals(
            InvitationState.EXPIRED,
            Team.state(invitation(expiresAt = "2025-07-01T00:00:00Z"), now),
        )
        assertEquals(InvitationState.PENDING, Team.state(invitation(), now))
    }

    @Test
    fun `an unreadable expiry is not treated as expired`() {
        // The remedy for a stale invitation is resend, and the server checks
        // the real expiry. Hiding a live one because the phone could not parse
        // a timestamp would strand it.
        assertEquals(InvitationState.PENDING, Team.state(invitation(expiresAt = "yesterday"), now))
        assertEquals(InvitationState.PENDING, Team.state(invitation(expiresAt = null), now))
    }

    @Test
    fun `the open list keeps only pending ones, newest first`() {
        val rows = listOf(
            invitation("old", createdAt = "2025-08-01T00:00:00Z"),
            invitation("gone", revokedAt = "2025-08-02T00:00:00Z"),
            invitation("new", createdAt = "2025-08-10T00:00:00Z"),
            invitation("stale", expiresAt = "2025-08-01T00:00:00Z"),
        )
        assertEquals(listOf("new", "old"), Team.open(rows, now).map { it.id })
    }

    @Test
    fun `an offset timestamp parses the same as a Z one`() {
        assertEquals(
            WorkspaceDate.parse("2025-08-11T00:00:00Z"),
            WorkspaceDate.parse("2025-08-11T00:00:00+00:00"),
        )
        assertNull(WorkspaceDate.parse(" "))
        assertNull(WorkspaceDate.parse(null))
    }

    @Test
    fun `days until never goes negative`() {
        assertEquals(14L, WorkspaceDate.daysUntil("2025-08-25T00:00:00Z", now))
        assertEquals(0L, WorkspaceDate.daysUntil("2025-01-01T00:00:00Z", now))
    }

    // ── email ────────────────────────────────────────────────────────────

    @Test
    fun `the email check matches the server's, and normalizes the same way`() {
        assertTrue(WorkspaceEmail.isValid("  Sam@Example.com "))
        assertFalse(WorkspaceEmail.isValid("sam"))
        assertFalse(WorkspaceEmail.isValid("sam @example.com"))
        assertEquals("sam@example.com", WorkspaceEmail.normalize("  Sam@Example.COM "))
    }
}
