package com.gradethread.app.marketplaces

import com.gradethread.app.marketplaces.EbaySyncService.ConnectionSnapshot
import com.gradethread.app.marketplaces.EbaySyncService.PollOutcome
import com.gradethread.app.marketplaces.EbaySyncService.PollingPolicy
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1351: the listing-pull poll contract — what counts as an advance, and
 * which of the four outcomes each situation produces. These are the rules that
 * decide whether a seller is told their sync worked, so they are tested rather
 * than trusted.
 */
class EbaySyncTest {

    // ── didAdvance ───────────────────────────────────────────────────────────

    @Test
    fun `first ever sync treats any timestamp as an advance`() {
        assertTrue(EbaySyncService.didAdvance(null, "2026-07-30T10:00:00Z"))
    }

    @Test
    fun `an unchanged cursor is not an advance`() {
        val at = "2026-07-30T10:00:00Z"
        assertFalse(EbaySyncService.didAdvance(at, at))
    }

    @Test
    fun `an older cursor is not an advance`() {
        assertFalse(
            EbaySyncService.didAdvance("2026-07-30T10:00:00Z", "2026-07-30T09:00:00Z"),
        )
    }

    @Test
    fun `a missing current cursor is not an advance`() {
        // The connection disappeared mid-sync. Reporting success here would
        // claim a sync finished against a row that no longer exists.
        assertFalse(EbaySyncService.didAdvance("2026-07-30T10:00:00Z", null))
    }

    @Test
    fun `mixed fractional-second precision compares as instants`() {
        // The baseline read and the poll read can come back at different
        // precisions; a plain string compare would call this an advance.
        assertFalse(
            EbaySyncService.didAdvance("2026-07-30T10:00:00.500Z", "2026-07-30T10:00:00Z"),
        )
        assertTrue(
            EbaySyncService.didAdvance("2026-07-30T10:00:00Z", "2026-07-30T10:00:00.500Z"),
        )
    }

    @Test
    fun `offset and Z forms of the same instant are not an advance`() {
        assertFalse(
            EbaySyncService.didAdvance("2026-07-30T10:00:00Z", "2026-07-30T12:00:00+02:00"),
        )
    }

    // ── pollUntilSynced ──────────────────────────────────────────────────────

    private val baseline = EbaySyncBaseline(lastSyncedAt = "2026-07-30T10:00:00Z")
    private val policy = PollingPolicy(intervalMs = 1_000, timeoutMs = 30_000)

    /** A clock the sleeper drives, so no test actually waits. */
    private class FakeClock {
        var nowMs = 0L
        val slept = mutableListOf<Long>()
        val sleeper: suspend (Long) -> Unit = { ms ->
            slept += ms
            nowMs += ms
        }
    }

    @Test
    fun `advancing cursor completes the poll`() = runTest {
        val clock = FakeClock()
        val outcome = EbaySyncService.pollUntilSynced(
            baseline = baseline,
            policy = policy,
            fetchSnapshot = { ConnectionSnapshot(lastSyncedAt = "2026-07-30T10:05:00Z") },
            now = { clock.nowMs },
            sleeper = clock.sleeper,
        )
        assertEquals(PollOutcome.Advanced, outcome)
    }

    @Test
    fun `a refresh error outranks an advanced cursor`() = runTest {
        val clock = FakeClock()
        val outcome = EbaySyncService.pollUntilSynced(
            baseline = baseline,
            policy = policy,
            fetchSnapshot = {
                ConnectionSnapshot(
                    lastSyncedAt = "2026-07-30T10:05:00Z",
                    refreshError = "token expired",
                )
            },
            now = { clock.nowMs },
            sleeper = clock.sleeper,
        )
        assertEquals(PollOutcome.Flagged("token expired"), outcome)
    }

    @Test
    fun `a stalled cursor times out rather than failing`() = runTest {
        val clock = FakeClock()
        val outcome = EbaySyncService.pollUntilSynced(
            baseline = baseline,
            policy = policy,
            fetchSnapshot = { ConnectionSnapshot(lastSyncedAt = baseline.lastSyncedAt) },
            now = { clock.nowMs },
            sleeper = clock.sleeper,
        )
        assertEquals(PollOutcome.TimedOut, outcome)
    }

    @Test
    fun `poll backs off instead of hammering a fixed interval`() = runTest {
        val clock = FakeClock()
        EbaySyncService.pollUntilSynced(
            baseline = baseline,
            policy = policy,
            fetchSnapshot = { ConnectionSnapshot(lastSyncedAt = baseline.lastSyncedAt) },
            now = { clock.nowMs },
            sleeper = clock.sleeper,
        )
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L), clock.slept.take(4))
        // Backoff, so the 30s window is a handful of polls, not thirty.
        assertTrue("polled ${clock.slept.size} times", clock.slept.size <= 8)
    }

    @Test
    fun `an unreachable endpoint stops early and says so`() = runTest {
        val clock = FakeClock()
        var calls = 0
        val outcome = EbaySyncService.pollUntilSynced(
            baseline = baseline,
            policy = policy,
            fetchSnapshot = { calls += 1; error("no route to host") },
            now = { clock.nowMs },
            sleeper = clock.sleeper,
        )
        assertEquals(
            PollOutcome.Failed(EbaySyncService.LOST_CONNECTION_MESSAGE),
            outcome,
        )
        assertEquals(EbaySyncService.MAX_CONSECUTIVE_POLL_FAILURES, calls)
    }

    @Test
    fun `a reachable server clears the failure streak`() = runTest {
        val clock = FakeClock()
        var call = 0
        val outcome = EbaySyncService.pollUntilSynced(
            baseline = baseline,
            policy = policy,
            fetchSnapshot = {
                call += 1
                // Two blips, one good-but-unchanged read, two more blips: five
                // failures in total but never three in a row, so the sync is
                // still waiting rather than declared dead.
                when (call) {
                    3 -> ConnectionSnapshot(lastSyncedAt = baseline.lastSyncedAt)
                    6 -> ConnectionSnapshot(lastSyncedAt = "2026-07-30T10:09:00Z")
                    else -> error("blip")
                }
            },
            now = { clock.nowMs },
            sleeper = clock.sleeper,
        )
        assertEquals(PollOutcome.Advanced, outcome)
    }

    // ── summary ──────────────────────────────────────────────────────────────

    @Test
    fun `summary reports deltas against the baseline`() {
        val summary = EbaySyncService.summarize(
            EbaySyncBaseline(listings = 10, activeListings = 8, sales = 3),
            listings = 14,
            activeListings = 11,
            sales = 5,
        )
        assertEquals(14, summary.listingsCount)
        assertEquals(11, summary.activeListingsCount)
        assertEquals(4, summary.listingsDelta)
        assertEquals(2, summary.salesDelta)
    }

    @Test
    fun `the completion message names only the deltas that moved`() {
        assertEquals(
            "12 listings.",
            MarketplacesViewModel.syncedMessage(EbaySyncSummary(listingsCount = 12)),
        )
        assertEquals(
            "12 listings, +2 since last sync, +1 sales.",
            MarketplacesViewModel.syncedMessage(
                EbaySyncSummary(listingsCount = 12, listingsDelta = 2, salesDelta = 1),
            ),
        )
        assertEquals(
            "9 listings, -3 since last sync.",
            MarketplacesViewModel.syncedMessage(
                EbaySyncSummary(listingsCount = 9, listingsDelta = -3),
            ),
        )
    }

    @Test
    fun `a shrinking listing count reports a negative delta`() {
        // Listings ending on eBay is real signal, not an error to hide.
        val summary = EbaySyncService.summarize(
            EbaySyncBaseline(listings = 10, sales = 3),
            listings = 7,
            activeListings = 5,
            sales = 3,
        )
        assertEquals(-3, summary.listingsDelta)
        assertEquals(0, summary.salesDelta)
    }
}
