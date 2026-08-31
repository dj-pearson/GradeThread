package com.gradethread.app.workspace

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.gradethread.app.ui.text
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1388: the workspace switcher's rules.
 *
 * Getting these wrong shows one seller another seller's stock, so every branch
 * that decides WHICH tenant the app is scoped to is checked here rather than on
 * a device with two accounts.
 */
@RunWith(RobolectricTestRunner::class)
class WorkspacesTest {

    // US-2976: the test is named "names whose data this is" - the claim is
    // about the WORDS, so they render rather than being checked as ids.
    private val context = ApplicationProvider.getApplicationContext<Context>()

    private val me = "user-self"

    // ── Building the list ────────────────────────────────────────────────────

    @Test
    fun `the personal workspace is always present and always first`() {
        // It is the one workspace that cannot be revoked, so it is the one the
        // app can always fall back to.
        val list = Workspaces.build(me, emptyList(), emptyMap())

        assertEquals(1, list.size)
        assertTrue(list.first().isPersonal)
        assertEquals(me, list.first().ownerId)
        assertEquals(Workspaces.PERSONAL_NAME, list.first().name)
    }

    @Test
    fun `shared workspaces take their owner's name`() {
        val list = Workspaces.build(
            selfId = me,
            memberOwnerIds = listOf("owner-b", "owner-a"),
            ownerNames = mapOf("owner-a" to "Alice's Closet", "owner-b" to "Bob Resells"),
        )

        assertEquals(
            listOf(Workspaces.PERSONAL_NAME, "Alice's Closet", "Bob Resells"),
            list.map { it.name },
        )
        // Personal stays pinned to the top; only the shared ones sort.
        assertTrue(list.first().isPersonal)
    }

    @Test
    fun `an owner with no name still gets a label`() {
        val list = Workspaces.build(me, listOf("owner-a"), mapOf("owner-a" to null))
        assertEquals(Workspaces.UNNAMED_SHARED, list[1].name)

        val blank = Workspaces.build(me, listOf("owner-a"), mapOf("owner-a" to "   "))
        assertEquals(Workspaces.UNNAMED_SHARED, blank[1].name)
    }

    @Test
    fun `a membership pointing at yourself is not a second workspace`() {
        // The owner of a workspace also has a membership row in it.
        val list = Workspaces.build(me, listOf(me, "owner-a"), emptyMap())

        assertEquals(2, list.size)
        assertEquals(1, list.count { it.ownerId == me })
    }

    @Test
    fun `duplicate and blank membership rows collapse`() {
        val list = Workspaces.build(me, listOf("owner-a", "owner-a", "", "  "), emptyMap())
        assertEquals(2, list.size)
    }

    // ── The switcher's visibility ────────────────────────────────────────────

    @Test
    fun `there is only a choice when there is somewhere to go`() {
        assertFalse(Workspaces.hasChoice(Workspaces.build(me, emptyList(), emptyMap())))
        assertTrue(Workspaces.hasChoice(Workspaces.build(me, listOf("owner-a"), emptyMap())))
    }

    // ── Stale selections ─────────────────────────────────────────────────────

    @Test
    fun `a selection that no longer exists is stale`() {
        // A membership revoked while the app was closed leaves an owner id in
        // preferences that every request then sends as X-Workspace-Owner.
        val list = Workspaces.build(me, listOf("owner-a"), emptyMap())

        assertTrue(Workspaces.isStale("owner-gone", list))
        assertFalse(Workspaces.isStale("owner-a", list))
        // Personal is stored as null and is never stale.
        assertFalse(Workspaces.isStale(null, list))
    }

    // ── Resolving the active one ─────────────────────────────────────────────

    @Test
    fun `no selection resolves to personal`() {
        val list = Workspaces.build(me, listOf("owner-a"), emptyMap())
        val active = Workspaces.active(list, activeOwnerId = null, selfId = me)

        assertEquals(me, active?.ownerId)
        assertTrue(active!!.isPersonal)
    }

    @Test
    fun `a selection resolves to that workspace`() {
        val list = Workspaces.build(me, listOf("owner-a"), mapOf("owner-a" to "Alice's Closet"))
        assertEquals("Alice's Closet", Workspaces.active(list, "owner-a", me)?.name)
    }

    @Test
    fun `a selection with no matching row resolves to nothing, not to personal`() {
        // Reporting "My workspace" while the header still says otherwise would
        // be the worst of both: wrong on screen AND wrong on the wire.
        val list = Workspaces.build(me, listOf("owner-a"), emptyMap())
        assertNull(Workspaces.active(list, "owner-gone", me))
    }

    // ── What gets stored ─────────────────────────────────────────────────────

    @Test
    fun `personal stores null, never your own id`() {
        // The edge defaults the tenant to the caller; a header naming yourself
        // is a different server code path for the same result.
        assertNull(Workspaces.scopeValue(me, me))
        assertEquals("owner-a", Workspaces.scopeValue("owner-a", me))
        assertNull(Workspaces.scopeValue("", me))
    }

    // ── Copy ─────────────────────────────────────────────────────────────────

    @Test
    fun `the subtitle names whose data this is`() {
        val list = Workspaces.build(me, listOf("owner-a"), emptyMap())

        assertEquals(
            "Your own inventory and sales",
            Workspaces.subtitle(Workspaces.active(list, null, me)).text(context),
        )
        assertEquals(
            "Shared workspace — you're a member",
            Workspaces.subtitle(Workspaces.active(list, "owner-a", me)).text(context),
        )
        assertEquals("Loading…", Workspaces.subtitle(null).text(context))
    }
}
