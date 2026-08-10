package com.gradethread.app.marketplaces

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-2481: the mobile half of the extension work queue.
 *
 * The wording is the load-bearing part here, which is why it is tested. A queued
 * job is not a done job: the desktop extension has to open before anything
 * happens on Poshmark, Mercari, Grailed, Vinted or Facebook. A screen that
 * reads like completion is not a cosmetic problem — for a delist it means the
 * seller believes their listing was pulled after the item sold elsewhere, and
 * the next buyer pays for something already shipped.
 */
class ExtensionQueueTest {

    private fun item(kind: String, platform: String) = ExtensionQueueItem(
        id = "q1",
        kind = kind,
        platform = platform,
        status = "queued",
    )

    @Test
    fun `the queued notice never reads as completion`() {
        assertTrue(
            "the notice must say WHERE the work runs",
            QUEUED_NOTICE.contains("desktop browser", ignoreCase = true),
        )
        assertTrue(
            "the notice must say nothing has happened yet",
            QUEUED_NOTICE.contains("until then", ignoreCase = true),
        )
        for (word in listOf("done", "complete", "listed", "published")) {
            assertFalse(
                "the queued notice contains \"$word\", which reads as a job that " +
                    "already ran",
                Regex("\\b$word\\b", RegexOption.IGNORE_CASE).containsMatchIn(QUEUED_NOTICE),
            )
        }
    }

    @Test
    fun `the notice matches the wording shipped on web and iOS`() {
        // One sentence across four surfaces (edge lib, web hook, iOS service,
        // here). A platform-specific rewrite is how one client ends up telling a
        // seller something the others do not.
        val expected =
            "This runs the next time you open your desktop browser with the " +
                "GradeThread extension installed. Nothing happens on the " +
                "marketplace until then."
        assertEquals(expected, QUEUED_NOTICE)
    }

    @Test
    fun `each kind describes what will actually happen`() {
        assertEquals("List to Poshmark", describeQueuedWork(item("list", "poshmark")))
        assertEquals("End the Mercari listing", describeQueuedWork(item("delist", "mercari")))
        assertEquals("Share your Poshmark closet", describeQueuedWork(item("share", "poshmark")))
    }

    @Test
    fun `every extension channel has a label`() {
        // A missing label falls back to the raw platform key, which would show a
        // seller "List to facebook" — the tell that a channel was added in one
        // place and not the other.
        for (platform in listOf("poshmark", "mercari", "grailed", "vinted", "facebook")) {
            val described = describeQueuedWork(item("list", platform))
            assertFalse(
                "$platform has no label — the raw key leaked into seller-facing copy",
                described.contains(platform),
            )
        }
    }

    @Test
    fun `an unknown platform degrades readably instead of crashing`() {
        assertEquals("List to Whatnot", describeQueuedWork(item("list", "whatnot")))
    }

    @Test
    fun `the kinds are exactly the three the extension can run`() {
        assertEquals(
            listOf("list", "delist", "share"),
            ExtensionQueueKind.entries.map { it.wire },
        )
    }
}
