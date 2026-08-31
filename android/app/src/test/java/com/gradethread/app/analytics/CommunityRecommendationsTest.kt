package com.gradethread.app.analytics

import com.gradethread.app.inventory.InventoryFilterRequests
import org.junit.After
import com.gradethread.app.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1369: the recommendation thresholds, the confidence model, and the states
 * that look the same on screen but mean different things.
 */
class CommunityRecommendationsTest {

    @After
    fun tearDown() = InventoryFilterRequests.clear()

    private fun brand(
        name: String = "Patagonia",
        sellers: Int = 10,
        listed: Int = 100,
        sold: Int = 60,
        sellThrough: Double? = 0.6,
        avgSalePrice: Double? = 85.0,
    ) = BrandBenchmark(name, sellers, listed, sold, sellThrough, avgSalePrice)

    private fun category(name: String = "Outerwear", sellers: Int = 8, growth: Double? = 0.25) =
        CategoryTrend(name, sellers, soldRecent = 50, soldPrevious = 40, growth = growth)

    // ── Confidence ───────────────────────────────────────────────────────────

    @Test
    fun `confidence starts at the k-anonymity floor and is capped below certainty`() {
        // A cohort is never certainty. A "100% confidence" badge on somebody
        // else's aggregate would be a promise this data cannot make.
        assertEquals(0.40, CommunityRecommendations.cohortConfidence(5), 0.0001)
        assertEquals(0.55, CommunityRecommendations.cohortConfidence(10), 0.0001)
        assertEquals(0.95, CommunityRecommendations.cohortConfidence(1000), 0.0001)
        // Below the floor can't reach the client at all, but it must not read
        // as MORE confident than the floor either.
        assertEquals(0.40, CommunityRecommendations.cohortConfidence(1), 0.0001)
    }

    @Test
    fun `confidence bands match the labels`() {
        assertEquals(ConfidenceLevel.HIGH, CommunityRecommendations.confidenceLevel(0.75))
        assertEquals(ConfidenceLevel.MEDIUM, CommunityRecommendations.confidenceLevel(0.55))
        assertEquals(ConfidenceLevel.LOW, CommunityRecommendations.confidenceLevel(0.54))
    }

    // ── Thresholds ───────────────────────────────────────────────────────────

    @Test
    fun `a brand below the sell-through floor is not suggested for sourcing`() {
        val weak = CommunityRecommendations.derive(
            CommunityBenchmarks(topBrands = listOf(brand(sellThrough = 0.49))),
        )
        assertTrue(weak.none { it.kind == RecommendationKind.SOURCE })
        // The pricing suggestion still stands: knowing what a brand sells FOR
        // is useful even when it sells slowly.
        assertTrue(weak.any { it.kind == RecommendationKind.PRICE })
    }

    @Test
    fun `a brand with no sell-through reading gets no sourcing advice`() {
        val recs = CommunityRecommendations.derive(
            CommunityBenchmarks(topBrands = listOf(brand(sellThrough = null))),
        )
        assertTrue(recs.none { it.kind == RecommendationKind.SOURCE })
    }

    @Test
    fun `a brand with no average price gets no pricing advice`() {
        val recs = CommunityRecommendations.derive(
            CommunityBenchmarks(topBrands = listOf(brand(avgSalePrice = null))),
        )
        assertTrue(recs.none { it.kind == RecommendationKind.PRICE })
        assertTrue(recs.any { it.kind == RecommendationKind.SOURCE })
    }

    @Test
    fun `a zero average price is not a price to aim at`() {
        val recs = CommunityRecommendations.derive(
            CommunityBenchmarks(topBrands = listOf(brand(avgSalePrice = 0.0))),
        )
        assertTrue(recs.none { it.kind == RecommendationKind.PRICE })
    }

    @Test
    fun `a category below the growth floor is not called rising`() {
        assertTrue(
            CommunityRecommendations.derive(
                CommunityBenchmarks(trendingCategories = listOf(category(growth = 0.14))),
            ).isEmpty(),
        )
        assertEquals(
            1,
            CommunityRecommendations.derive(
                CommunityBenchmarks(trendingCategories = listOf(category(growth = 0.15))),
            ).size,
        )
    }

    // ── Ranking and content ──────────────────────────────────────────────────

    @Test
    fun `recommendations are ranked best first`() {
        val recs = CommunityRecommendations.derive(
            CommunityBenchmarks(
                topBrands = listOf(
                    brand("Slow", sellThrough = 0.51, avgSalePrice = 20.0),
                    brand("Fast", sellThrough = 0.95, avgSalePrice = 20.0),
                ),
            ),
        )
        val sources = recs.filter { it.kind == RecommendationKind.SOURCE }
        assertEquals(listOf("Fast", "Slow"), sources.map { it.subject })
        assertTrue(recs.zipWithNext().all { (a, b) -> a.score >= b.score })
    }

    @Test
    fun `a brand recommendation carries the filter to deep-link with`() {
        val rec = CommunityRecommendations.derive(
            CommunityBenchmarks(topBrands = listOf(brand("Carhartt"))),
        ).first()

        assertEquals("Carhartt", rec.brandFilter)
        // US-2976: the COHORT SIZE is what "sellers" was standing in for - the
        // number a seller weighs the recommendation by. It is the first
        // argument in every detail shape, and it picks the plural form.
        //
        // Deliberately NOT asserting which resource: `first()` is whichever
        // recommendation ranks highest, and pinning that here would make this
        // test fail whenever the SCORING changes, which is not what it is for.
        assertEquals(rec.cohortSize, rec.detail.args[0])
        assertEquals(rec.cohortSize, rec.detail.quantity)
    }

    @Test
    fun `a category recommendation has nothing to filter by`() {
        // The local item mirror has no category column, so a category filter
        // would match nothing and the tap would look broken.
        val rec = CommunityRecommendations.derive(
            CommunityBenchmarks(trendingCategories = listOf(category("Denim"))),
        ).single()

        assertNull(rec.brandFilter)
        assertEquals("Denim", rec.subject)
    }

    // ── Empty versus nothing-actionable ──────────────────────────────────────

    @Test
    fun `having data and having advice are different states`() {
        // These look identical on screen and mean opposite things: one is a
        // wait, the other is a judgement.
        val quiet = CommunityBenchmarks(topBrands = listOf(brand(sellThrough = 0.1, avgSalePrice = null)))
        assertTrue(quiet.hasBenchmarkData)
        assertTrue(CommunityRecommendations.derive(quiet).isEmpty())

        assertFalse(CommunityBenchmarks().hasBenchmarkData)
    }

    // ── Peer standing ────────────────────────────────────────────────────────

    @Test
    fun `peer standing names where you sit`() {
        val you = SellerSummary(
            listed = 40,
            sold = 30,
            sellThrough = 0.75,
            peerComparison = PeerComparison(
                peerCount = 12,
                peerMedianSellThrough = 0.5,
                yourSellThrough = 0.75,
                percentile = 0.8,
            ),
        )
        val text = CommunityRecommendations.peerStanding(you)!!

        assertTrue(text.contains("75%"))
        assertTrue(text.contains("above"))
        assertTrue(text.contains("12 sellers"))
        assertNull(CommunityRecommendations.peerStandingBlocker(you))
    }

    @Test
    fun `no comparison is withheld rather than invented`() {
        // The RPC omits peerComparison below five peers. A percentile with no
        // rate behind it is not a position.
        assertNull(CommunityRecommendations.peerStanding(SellerSummary(listed = 40)))
        assertNull(
            CommunityRecommendations.peerStanding(
                SellerSummary(
                    listed = 40,
                    peerComparison = PeerComparison(peerCount = 9, yourSellThrough = null),
                ),
            ),
        )
    }

    @Test
    fun `a thin seller is told what would unlock the comparison`() {
        // Two DIFFERENT resources: one names a thing the seller can do, the
        // other says to wait. Telling them apart is the whole point.
        assertEquals(
            R.string.community_need_three,
            CommunityRecommendations.peerStandingBlocker(SellerSummary(listed = 1)),
        )
        assertEquals(
            R.string.community_no_peers,
            CommunityRecommendations.peerStandingBlocker(SellerSummary(listed = 40)),
        )
    }

    // ── Deep-link handoff ────────────────────────────────────────────────────

    @Test
    fun `a brand request is consumed exactly once`() {
        // Left set, the filter would re-apply every time the seller returned to
        // the tab and feel impossible to clear.
        InventoryFilterRequests.requestBrand("Patagonia")
        assertEquals("Patagonia", InventoryFilterRequests.consumeBrand())
        assertNull(InventoryFilterRequests.consumeBrand())
    }

    @Test
    fun `a blank brand is never requested`() {
        InventoryFilterRequests.requestBrand("   ")
        assertNull(InventoryFilterRequests.brand.value)
    }

    @Test
    fun `a brand request is trimmed`() {
        InventoryFilterRequests.requestBrand("  Nike ")
        assertEquals("Nike", InventoryFilterRequests.brand.value)
        assertNotNull(InventoryFilterRequests.consumeBrand())
    }
}
