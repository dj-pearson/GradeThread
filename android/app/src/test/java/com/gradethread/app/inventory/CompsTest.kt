package com.gradethread.app.inventory

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1346: comps — the three no-result states that mean different things, and
 * the saved-comp column that several surfaces have written over time.
 */
class CompsTest {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    // ── stats ────────────────────────────────────────────────────────────

    @Test
    fun `use-median is gated on a median, not on a count`() {
        // Every percentile is independently nullable, so a result can report
        // comparable listings and still have no median. Offering the button
        // then would write null into the price field.
        assertFalse(CompStats(count = 12, median = null).hasMedian)
        assertFalse(CompStats(count = 12, median = 0.0).hasMedian)
        assertTrue(CompStats(count = 1, median = 42.0).hasMedian)
        assertFalse(CompStats(count = 0).hasMedian)
    }

    @Test
    fun `the stats payload decodes with every percentile absent`() {
        val decoded = json.decodeFromString(
            CompsResponse.serializer(),
            """{"stats":{"count":0,"currency":"USD"},"items":[],"total":0}""",
        )
        assertEquals(0, decoded.stats.count)
        assertNull(decoded.stats.median)
    }

    @Test
    fun `a full stats payload decodes`() {
        val decoded = json.decodeFromString(
            CompsResponse.serializer(),
            """{"stats":{"count":34,"currency":"USD","min":18.0,"p25":32.5,
                "median":45.0,"p75":61.25,"max":140.0}}""",
        )
        assertEquals(45.0, decoded.stats.median!!, 1e-9)
        assertTrue(decoded.stats.hasMedian)
    }

    // ── the degraded state (US-1559) ─────────────────────────────────────

    @Test
    fun `a degraded taxonomy response is distinguishable from no matches`() {
        // eBay's Taxonomy API intermittently 500s and the edge degrades to an
        // empty list rather than a 502. Both arrive as zero suggestions, but
        // one is worth retrying in a minute and the other never will be.
        val degraded = json.decodeFromString(
            CategorySuggestResponse.serializer(),
            """{"suggestions":[],"degraded":true}""",
        )
        val genuinelyEmpty = json.decodeFromString(
            CategorySuggestResponse.serializer(),
            """{"suggestions":[]}""",
        )
        assertTrue(degraded.degraded)
        assertFalse(genuinelyEmpty.degraded)
    }

    @Test
    fun `the suggest query leads with the brand`() {
        // The taxonomy match is much better with a brand, and a photo-first
        // item's title is often still "Untitled item".
        assertEquals(
            "Patagonia Better Sweater",
            CompsService.suggestQuery("Better Sweater", "Patagonia"),
        )
        assertEquals("Better Sweater", CompsService.suggestQuery("Better Sweater", null))
        assertEquals("Better Sweater", CompsService.suggestQuery("Better Sweater", "  "))
        assertEquals("", CompsService.suggestQuery("  ", null))
    }

    // ── comp_set decoding ────────────────────────────────────────────────

    @Test
    fun `a price stored as a string still decodes`() {
        // The column has been written by several surfaces over time; a strict
        // decode would drop a seller's whole saved list over one quoted value.
        val comps = CompSet.decode("""[{"price":"42.50","source":"eBay"},{"price":30}]""")
        assertEquals(listOf(42.50, 30.0), comps.map { it.price })
        assertEquals("eBay", comps[0].source)
    }

    @Test
    fun `rows with no usable price are skipped, not stored as zero`() {
        // A $0 comp would drag any average built on it.
        val comps = CompSet.decode(
            """[{"price":"not a number"},{"source":"x"},{"price":0},{"price":25}]""",
        )
        assertEquals(listOf(25.0), comps.map { it.price })
    }

    @Test
    fun `a malformed comp_set degrades to empty rather than crashing`() {
        assertEquals(emptyList<ItemComp>(), CompSet.decode("not json"))
        assertEquals(emptyList<ItemComp>(), CompSet.decode("""{"not":"an array"}"""))
        assertEquals(emptyList<ItemComp>(), CompSet.decode(null))
        assertEquals(emptyList<ItemComp>(), CompSet.decode(""))
    }

    @Test
    fun `optional fields round-trip and blanks are omitted`() {
        val encoded = CompSet.encode(
            listOf(
                ItemComp(price = 42.5, source = "eBay", url = "https://x", soldDate = "2026-07-01"),
                ItemComp(price = 30.0, source = "  ", notes = null),
            ),
        )!!
        assertTrue(encoded.contains(""""sold_date":"2026-07-01""""))
        // A blank source is omitted, not written as "".
        assertFalse(encoded.contains(""""source":"  """"))
        val round = CompSet.decode(encoded)
        assertEquals(2, round.size)
        assertEquals("eBay", round[0].source)
        assertNull(round[1].source)
    }

    @Test
    fun `an empty comp set encodes to null, not an empty array`() {
        // Same rule as measurements: "[]" claims the seller looked and found
        // nothing; null means they never saved any.
        assertNull(CompSet.encode(emptyList()))
        assertNull(CompSet.encode(listOf(ItemComp(price = 0.0))))
    }

    // ── the seller's own median ──────────────────────────────────────────

    @Test
    fun `an odd-sized comp list takes the middle value`() {
        val median = CompSet.median(
            listOf(ItemComp(price = 50.0), ItemComp(price = 10.0), ItemComp(price = 30.0)),
        )
        assertEquals(30.0, median!!, 1e-9)
    }

    @Test
    fun `an even-sized comp list averages the middle pair`() {
        val median = CompSet.median(
            listOf(ItemComp(price = 10.0), ItemComp(price = 20.0), ItemComp(price = 30.0), ItemComp(price = 60.0)),
        )
        assertEquals(25.0, median!!, 1e-9)
    }

    @Test
    fun `no comps means no median`() {
        assertNull(CompSet.median(emptyList()))
        assertNull(CompSet.median(listOf(ItemComp(price = 0.0))))
    }
}
