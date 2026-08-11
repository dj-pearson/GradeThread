package com.gradethread.app.autolister

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-2408: the grouping rules a whole batch of listings comes out of.
 *
 * Every edit runs through `normalize`, so these tests are mostly asking one
 * question: after this edit, is each photo still in exactly one group, and is
 * each group's cover still one of its own photos? A break in either produces a
 * listing carrying another item's photos.
 */
class AutolisterSessionTest {

    private fun photo(id: String) = SessionPhoto(
        id = id,
        storagePath = "u1/_staging/s1/$id.jpg",
        url = "https://cdn/$id.jpg",
    )

    private fun session(
        photoIds: List<String>,
        groups: List<SessionGroup> = emptyList(),
    ) = AutolisterSessionState(
        stagingSessionId = "s1",
        photos = photoIds.map(::photo),
        groups = groups,
    )

    private fun group(id: String, vararg photoIds: String, cover: String? = null) =
        SessionGroup(id = id, photoIds = photoIds.toList(), coverId = cover)

    // ── the invariants ───────────────────────────────────────────────────

    @Test
    fun `a photo contested by two groups stays with the first`() {
        // The server's own parser resolves an overlap the same way, so a client
        // and a server that disagree still land on the same grouping.
        val state = AutolisterGroups.normalize(
            session(listOf("a", "b", "c"), listOf(group("g1", "a", "b"), group("g2", "b", "c"))),
        )
        assertEquals(listOf("a", "b"), state.group("g1")!!.photoIds)
        assertEquals(listOf("c"), state.group("g2")!!.photoIds)
    }

    @Test
    fun `a group left with no photos disappears`() {
        val state = AutolisterGroups.normalize(
            session(listOf("a"), listOf(group("g1", "a"), group("g2", "a"))),
        )
        assertEquals(listOf("g1"), state.groups.map { it.id })
    }

    @Test
    fun `a group referencing a photo that is gone drops it`() {
        val state = AutolisterGroups.normalize(session(listOf("a"), listOf(group("g1", "a", "ghost"))))
        assertEquals(listOf("a"), state.group("g1")!!.photoIds)
    }

    @Test
    fun `a cover that is not a member falls back to the first photo`() {
        val state = AutolisterGroups.normalize(
            session(listOf("a", "b"), listOf(group("g1", "a", "b", cover = "zzz"))),
        )
        assertEquals("a", state.group("g1")!!.coverId)
    }

    // ── adding and removing ──────────────────────────────────────────────

    @Test
    fun `adding photos ignores ids the session already holds`() {
        val state = AutolisterGroups.withPhotos(session(listOf("a")), listOf(photo("a"), photo("b")))
        assertEquals(listOf("a", "b"), state.photos.map { it.id })
    }

    @Test
    fun `the session stops at the server's handoff cap`() {
        val many = (1..AutolisterGroups.MAX_PHOTOS + 20).map { photo("p$it") }
        val state = AutolisterGroups.withPhotos(AutolisterSessionState(), many)
        assertEquals(AutolisterGroups.MAX_PHOTOS, state.photos.size)
    }

    @Test
    fun `removing a photo takes it out of its group too`() {
        val state = AutolisterGroups.withoutPhoto(
            session(listOf("a", "b"), listOf(group("g1", "a", "b"))),
            "a",
        )
        assertEquals(listOf("b"), state.photos.map { it.id })
        assertEquals(listOf("b"), state.group("g1")!!.photoIds)
        assertEquals("b", state.group("g1")!!.coverId)
    }

    // ── the edits ────────────────────────────────────────────────────────

    @Test
    fun `grouping takes photos away from whatever held them`() {
        val state = AutolisterGroups.grouped(
            session(listOf("a", "b", "c"), listOf(group("g1", "a", "b"))),
            listOf("b", "c"),
            "g2",
        )
        assertEquals(listOf("a"), state.group("g1")!!.photoIds)
        assertEquals(listOf("b", "c"), state.group("g2")!!.photoIds)
        assertTrue(state.ungrouped.isEmpty())
    }

    @Test
    fun `merging keeps order and removes the source group`() {
        val state = AutolisterGroups.merged(
            session(listOf("a", "b", "c"), listOf(group("g1", "a"), group("g2", "b", "c"))),
            intoId = "g1",
            fromId = "g2",
        )
        assertEquals(listOf("g1"), state.groups.map { it.id })
        assertEquals(listOf("a", "b", "c"), state.group("g1")!!.photoIds)
    }

    @Test
    fun `merging a group into itself changes nothing`() {
        val before = session(listOf("a"), listOf(group("g1", "a")))
        assertEquals(before, AutolisterGroups.merged(before, "g1", "g1"))
    }

    @Test
    fun `splitting out every photo is refused`() {
        // That is a rename, not a split: normalize would delete the emptied
        // group, so the group would silently change id.
        val before = session(listOf("a", "b"), listOf(group("g1", "a", "b")))
        assertEquals(before, AutolisterGroups.split(before, "g1", listOf("a", "b"), "g2"))
        assertEquals(before, AutolisterGroups.split(before, "g1", emptyList(), "g2"))
    }

    @Test
    fun `splitting moves the named photos into a new group`() {
        val state = AutolisterGroups.split(
            session(listOf("a", "b", "c"), listOf(group("g1", "a", "b", "c"))),
            "g1", listOf("c"), "g2",
        )
        assertEquals(listOf("a", "b"), state.group("g1")!!.photoIds)
        assertEquals(listOf("c"), state.group("g2")!!.photoIds)
    }

    @Test
    fun `moving pulls a photo out of its old group`() {
        val state = AutolisterGroups.moved(
            session(listOf("a", "b", "c"), listOf(group("g1", "a", "b"), group("g2", "c"))),
            listOf("b"), "g2",
        )
        assertEquals(listOf("a"), state.group("g1")!!.photoIds)
        assertEquals(listOf("c", "b"), state.group("g2")!!.photoIds)
    }

    @Test
    fun `moving an ungrouped photo into a group works and moving into a missing group does not`() {
        val before = session(listOf("a", "b"), listOf(group("g1", "a")))
        assertEquals(listOf("a", "b"), AutolisterGroups.moved(before, listOf("b"), "g1").group("g1")!!.photoIds)
        assertEquals(before, AutolisterGroups.moved(before, listOf("b"), "nope"))
    }

    @Test
    fun `breaking up a group sends its photos back to the tray`() {
        val state = AutolisterGroups.ungrouped(
            session(listOf("a", "b"), listOf(group("g1", "a", "b"))),
            "g1",
        )
        assertTrue(state.groups.isEmpty())
        assertEquals(listOf("a", "b"), state.ungrouped.map { it.id })
    }

    @Test
    fun `a cover can only be set to a photo in that group`() {
        val before = session(listOf("a", "b", "c"), listOf(group("g1", "a", "b")))
        assertEquals("b", AutolisterGroups.withCover(before, "g1", "b").group("g1")!!.coverId)
        // "c" is not a member, so the cover falls back rather than pointing at
        // a photo the group does not contain.
        assertEquals("a", AutolisterGroups.withCover(before, "g1", "c").group("g1")!!.coverId)
    }

    // ── the AI passes ────────────────────────────────────────────────────

    @Test
    fun `propose windows never send fewer photos than the endpoint accepts`() {
        val photos = (1..41).map { photo("p$it") }
        val windows = AutolisterGroups.proposeWindows(photos)
        // 41 photos is a full window of 40 and a trailing one, which the
        // endpoint refuses and which has nothing to be grouped with anyway.
        assertEquals(1, windows.size)
        assertEquals(AutolisterGroups.PROPOSE_WINDOW, windows.first().size)

        assertEquals(3, AutolisterGroups.proposeWindows((1..90).map { photo("q$it") }).size)
        assertTrue(AutolisterGroups.proposeWindows(listOf(photo("only"))).isEmpty())
    }

    @Test
    fun `a proposal only claims photos that are still ungrouped`() {
        // The seller grouped "b" by hand after the pass was sent. Pulling it
        // back out would undo their work with nothing on screen to say so.
        val state = AutolisterGroups.applyProposals(
            session(listOf("a", "b", "c"), listOf(group("g1", "b"))),
            listOf(ProposedGroup(photoIds = listOf("a", "b", "c"), confidence = 0.9)),
            listOf("g2"),
        )
        assertEquals(listOf("b"), state.group("g1")!!.photoIds)
        assertEquals(listOf("a", "c"), state.group("g2")!!.photoIds)
    }

    @Test
    fun `a proposal reduced to one surviving photo is dropped`() {
        val state = AutolisterGroups.applyProposals(
            session(listOf("a", "b"), listOf(group("g1", "b"))),
            listOf(ProposedGroup(photoIds = listOf("a", "b"))),
            listOf("g2"),
        )
        assertNull(state.group("g2"))
        assertEquals(listOf("a"), state.ungrouped.map { it.id })
    }

    @Test
    fun `verification needs two groups`() {
        assertFalse(AutolisterGroups.canVerify(session(listOf("a"), listOf(group("g1", "a")))))
        assertTrue(
            AutolisterGroups.canVerify(
                session(listOf("a", "b"), listOf(group("g1", "a"), group("g2", "b"))),
            ),
        )
    }

    @Test
    fun `a merge suggestion folds the second group into the first`() {
        val state = AutolisterGroups.applySuggestion(
            session(listOf("a", "b"), listOf(group("g1", "a"), group("g2", "b"))),
            GroupSuggestion(type = "merge", groupIds = listOf("g1", "g2")),
            "new",
        )
        assertEquals(listOf("g1"), state.groups.map { it.id })
        assertEquals(listOf("a", "b"), state.group("g1")!!.photoIds)
    }

    @Test
    fun `a move suggestion sends the named photos to the second group`() {
        val state = AutolisterGroups.applySuggestion(
            session(listOf("a", "b", "c"), listOf(group("g1", "a", "b"), group("g2", "c"))),
            GroupSuggestion(type = "move", groupIds = listOf("g1", "g2"), photoIds = listOf("b")),
            "new",
        )
        assertEquals(listOf("a"), state.group("g1")!!.photoIds)
        assertEquals(listOf("c", "b"), state.group("g2")!!.photoIds)
    }

    @Test
    fun `a suggestion type we do not know changes nothing`() {
        val before = session(listOf("a"), listOf(group("g1", "a")))
        assertEquals(before, AutolisterGroups.applySuggestion(before, GroupSuggestion(type = "wat"), "new"))
    }

    // ── the handoff payload ──────────────────────────────────────────────

    @Test
    fun `the handoff puts each group's cover first`() {
        val payload = AutolisterGroups.handoff(
            session(listOf("a", "b", "c"), listOf(group("g1", "a", "b", "c", cover = "c"))),
        )
        assertEquals(listOf("c", "a", "b"), payload.groups.single().photoIds)
        assertEquals("c", payload.groups.single().coverId)
        assertEquals("android", payload.source)
        assertEquals("s1", payload.stagingSessionId)
    }

    @Test
    fun `ungrouped photos still go, so nothing the seller shot is silently lost`() {
        val payload = AutolisterGroups.handoff(
            session(listOf("a", "b"), listOf(group("g1", "a"))),
        )
        assertEquals(listOf("a", "b"), payload.photos.map { it.id })
        assertEquals(1, payload.groups.size)
    }

    // ── persistence ──────────────────────────────────────────────────────

    @Test
    fun `a session round-trips through the JSON that Room stores`() {
        // This is what makes the batch survive a process kill: if the state
        // cannot be written and read back whole, twenty minutes of sorting is
        // gone the first time the phone rings.
        val before = session(listOf("a", "b"), listOf(group("g1", "a", "b", cover = "b")))
            .copy(suggestions = listOf(GroupSuggestion(type = "merge", groupIds = listOf("g1"))))
        val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
        val text = json.encodeToString(AutolisterSessionState.serializer(), before)
        assertEquals(before, json.decodeFromString(AutolisterSessionState.serializer(), text))
    }

    @Test
    fun `a photo with no EXIF time serializes its absence, not a zero`() {
        // The server reads captured_at_ms as when the garment was shot. A zero
        // would place every timeless photo in 1970 and read as one long burst.
        val json = Json { encodeDefaults = true }
        val text = json.encodeToString(SessionPhoto.serializer(), photo("a"))
        assertTrue(text.contains("\"captured_at_ms\":null"))
        assertFalse(text.contains("\"captured_at_ms\":0"))
    }
}
