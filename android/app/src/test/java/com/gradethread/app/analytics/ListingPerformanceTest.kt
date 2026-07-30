package com.gradethread.app.analytics

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1368 AC2: the listing drill-down's sort, filter and derived numbers.
 */
class ListingPerformanceTest {

    private val now = 1_800_000_000_000L
    private val day = 86_400_000L

    private fun row(
        id: String,
        title: String? = "Listing $id",
        views: Int = 0,
        watchers: Int = 0,
        impressions: Int = 0,
        ctr: Double? = null,
        listedDaysAgo: Int? = 10,
    ) = ListingPerformanceRow(
        id = id,
        inventoryItemId = "item-$id",
        title = title,
        listingUrl = null,
        listingPrice = 25.0,
        listedAtMs = listedDaysAgo?.let { now - it * day },
        viewsTotal = views,
        watchersCount = watchers,
        impressions7d = impressions,
        clickThroughRate = ctr,
    )

    @Test
    fun `days listed is whole days, never negative`() {
        assertEquals(10, ListingPerformance.daysListed(now - 10 * day, now))
        assertEquals(0, ListingPerformance.daysListed(null, now))
        // A listed_at in the future (clock skew) reads as brand new, not as a
        // negative age that would sort above everything.
        assertEquals(0, ListingPerformance.daysListed(now + 5 * day, now))
    }

    @Test
    fun `stale means no views after two weeks, not on day two`() {
        // A warning that every new listing triggers is a warning nobody reads.
        assertFalse(ListingPerformance.isStale(row("a", listedDaysAgo = 3), now))
        assertFalse(ListingPerformance.isStale(row("b", views = 1, listedDaysAgo = 60), now))
        assertTrue(ListingPerformance.isStale(row("c", listedDaysAgo = 14), now))
    }

    @Test
    fun `velocity is withheld on the first day`() {
        // 40 views in the first hours does not prove 40 views a day, and
        // printing that would be the most flattering possible reading of no
        // data.
        assertNull(ListingPerformance.viewsPerDay(row("a", views = 40, listedDaysAgo = 0), now))
        assertEquals(
            4.0,
            ListingPerformance.viewsPerDay(row("b", views = 40, listedDaysAgo = 10), now)!!,
            0.001,
        )
    }

    @Test
    fun `watch rate needs someone to have looked`() {
        assertNull(ListingPerformance.watchRate(row("a", views = 0, watchers = 0)))
        assertEquals(0.1, ListingPerformance.watchRate(row("b", views = 100, watchers = 10))!!, 0.001)
    }

    @Test
    fun `a missing click-through sorts below every real one`() {
        // As a 0.0 it would sort ABOVE a listing with a genuine 0% reading,
        // which is the opposite of what the number means.
        val rows = listOf(
            row("none", ctr = null),
            row("zero", ctr = 0.0),
            row("good", ctr = 0.05),
        )

        val sorted = ListingPerformance.resolve(
            rows,
            ListingPerformanceSort.CTR,
            ascending = false,
            nowMs = now,
        )
        assertEquals(listOf("good", "zero", "none"), sorted.map { it.id })
    }

    @Test
    fun `sorting by views puts the best first by default`() {
        val rows = listOf(row("a", views = 3), row("b", views = 30), row("c", views = 10))
        assertEquals(
            listOf("b", "c", "a"),
            ListingPerformance.resolve(
                rows,
                ListingPerformanceSort.VIEWS,
                ascending = false,
                nowMs = now,
            ).map { it.id },
        )
        assertFalse(ListingPerformanceSort.VIEWS.defaultAscending)
        assertTrue(ListingPerformanceSort.TITLE.defaultAscending)
    }

    @Test
    fun `title sorts alphabetically and ignores case`() {
        val rows = listOf(row("a", title = "zebra"), row("b", title = "Apple"), row("c", title = null))
        assertEquals(
            listOf("b", "c", "a"),
            ListingPerformance.resolve(
                rows,
                ListingPerformanceSort.TITLE,
                ascending = true,
                nowMs = now,
            ).map { it.id },
        )
    }

    @Test
    fun `the no-views filter keeps only listings old enough to judge`() {
        val rows = listOf(
            row("fresh", views = 0, listedDaysAgo = 3),
            row("quiet", views = 0, listedDaysAgo = 20),
            row("busy", views = 12, listedDaysAgo = 20),
        )

        val filtered = ListingPerformance.resolve(
            rows,
            ListingPerformanceSort.VIEWS,
            ascending = false,
            minNoViewDays = 14,
            nowMs = now,
        )
        assertEquals(listOf("quiet"), filtered.map { it.id })
    }

    @Test
    fun `no filter keeps everything`() {
        val rows = listOf(row("a"), row("b"))
        assertEquals(2, ListingPerformance.resolve(rows, ListingPerformanceSort.VIEWS, false, null, now).size)
    }

    @Test
    fun `the summary says how many listings are going nowhere`() {
        assertEquals(
            "No active eBay listings with metrics yet.",
            ListingPerformance.summary(emptyList(), now),
        )
        assertEquals(
            "1 active listing · 12 total views",
            ListingPerformance.summary(listOf(row("a", views = 12)), now),
        )
        assertEquals(
            "2 active listings · 12 total views · 1 with no views after two weeks",
            ListingPerformance.summary(
                listOf(row("a", views = 12), row("b", views = 0, listedDaysAgo = 30)),
                now,
            ),
        )
    }
}
