package com.gradethread.app.verified

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1375: the status derivation and the checklist.
 */
class VerifiedBadgeTest {

    private fun profile(
        handle: String? = null,
        enabled: Boolean = false,
        embed: Boolean = false,
        since: String? = null,
    ) = VerifiedProfile(
        handle = handle,
        enabled = enabled,
        embedInListings = embed,
        verifiedSince = since,
    )

    // ── Status ───────────────────────────────────────────────────────────────

    @Test
    fun `a fresh account is locked`() {
        assertEquals(VerifiedStatus.LOCKED, VerifiedBadge.status(profile()))
    }

    @Test
    fun `a handle with the profile off is ready but hidden`() {
        assertEquals(VerifiedStatus.HIDDEN, VerifiedBadge.status(profile(handle = "abc")))
    }

    @Test
    fun `the profile on with no handle needs a handle`() {
        // Switched on but with nowhere to point at — a distinct and fixable
        // state, not the same as not having started.
        assertEquals(
            VerifiedStatus.HANDLE_NEEDED,
            VerifiedBadge.status(profile(enabled = true)),
        )
    }

    @Test
    fun `a handle plus the profile on is live`() {
        assertEquals(
            VerifiedStatus.LIVE,
            VerifiedBadge.status(profile(handle = "abc", enabled = true)),
        )
    }

    @Test
    fun `a blank handle is not a handle`() {
        assertEquals(
            VerifiedStatus.HANDLE_NEEDED,
            VerifiedBadge.status(profile(handle = "   ", enabled = true)),
        )
    }

    @Test
    fun `the listing embed does not decide whether the badge is live`() {
        // It controls the trust block INSIDE eBay listings. Folding it into
        // status would tell a seller with a perfectly live badge they aren't
        // verified.
        assertEquals(
            VerifiedStatus.LIVE,
            VerifiedBadge.status(profile(handle = "abc", enabled = true, embed = false)),
        )
    }

    // ── Requirements ─────────────────────────────────────────────────────────

    @Test
    fun `the checklist is in the order someone would do it`() {
        val requirements = VerifiedBadge.requirements(profile(), VerifiedStats())
        assertEquals(
            listOf(
                "Claim your handle",
                "Get an item certified",
                "Turn your public profile on",
                "Show the badge on your listings",
            ),
            requirements.map { it.title },
        )
        assertTrue(requirements.none { it.met })
    }

    @Test
    fun `a claimed handle is shown back to the seller`() {
        val requirement = VerifiedBadge
            .requirements(profile(handle = "flipqueen"), VerifiedStats())
            .first()
        assertTrue(requirement.met)
        assertEquals("You're @flipqueen.", requirement.detail)
    }

    @Test
    fun `one certified grade clears the grading requirement`() {
        // The badge's whole content is the grading record; an empty one makes
        // it decoration.
        val none = VerifiedBadge.requirements(profile(), VerifiedStats(totalGraded = 0))[1]
        assertFalse(none.met)

        val one = VerifiedBadge.requirements(profile(), VerifiedStats(totalGraded = 1))[1]
        assertTrue(one.met)
        assertEquals("1 certified so far.", one.detail)
    }

    // ── Progress and next step ───────────────────────────────────────────────

    @Test
    fun `progress counts only what actually gates the badge`() {
        // Three gating steps; the listing embed is optional and must not make a
        // live badge look incomplete.
        val live = VerifiedBadge.requirements(
            profile(handle = "abc", enabled = true, embed = false),
            VerifiedStats(totalGraded = 4),
        )
        assertEquals(1f, VerifiedBadge.progress(live), 0.001f)
        assertNull(VerifiedBadge.nextStep(live))
    }

    @Test
    fun `progress is a third at a time`() {
        val one = VerifiedBadge.requirements(profile(handle = "abc"), VerifiedStats())
        assertEquals(1f / 3f, VerifiedBadge.progress(one), 0.001f)
    }

    @Test
    fun `the next step is the first thing undone, not a list of four`() {
        val fresh = VerifiedBadge.requirements(profile(), VerifiedStats())
        assertEquals("Claim your handle", VerifiedBadge.nextStep(fresh)!!.title)

        val withHandle = VerifiedBadge.requirements(profile(handle = "abc"), VerifiedStats())
        assertEquals("Get an item certified", VerifiedBadge.nextStep(withHandle)!!.title)
    }

    @Test
    fun `an empty checklist has no progress and no next step`() {
        assertEquals(0f, VerifiedBadge.progress(emptyList()), 0.001f)
        assertNull(VerifiedBadge.nextStep(emptyList()))
    }

    // ── Labels ───────────────────────────────────────────────────────────────

    @Test
    fun `the public link only exists once a handle does`() {
        assertNull(VerifiedBadge.profileUrl(profile()))
        assertNull(VerifiedBadge.profileUrl(profile(handle = "  ")))
        assertEquals(
            "https://gradethread.com/verified/abc",
            VerifiedBadge.profileUrl(profile(handle = " abc ")),
        )
    }

    @Test
    fun `the since label cuts the timestamp rather than parsing it`() {
        // The edge sends fractional seconds; parsing just to reformat would add
        // a failure mode for no gain.
        assertEquals(
            "Verified since 2026-03-04",
            VerifiedBadge.sinceLabel(profile(since = "2026-03-04T09:12:33.412Z")),
        )
        assertNull(VerifiedBadge.sinceLabel(profile()))
        assertNull(VerifiedBadge.sinceLabel(profile(since = "  ")))
    }

    @Test
    fun `credentials are withheld until there is a record to show`() {
        assertNull(VerifiedBadge.credentials(VerifiedStats(totalGraded = 0, averageGrade = 0.0)))
        assertEquals(
            "1 certified item · 8.4 average grade",
            VerifiedBadge.credentials(VerifiedStats(totalGraded = 1, averageGrade = 8.4)),
        )
        assertEquals(
            "12 certified items · 9.0 average grade",
            VerifiedBadge.credentials(VerifiedStats(totalGraded = 12, averageGrade = 9.0)),
        )
    }
}
