package com.gradethread.app.marketplaces

import com.gradethread.app.platform.net.Backoff
import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.sync.ConflictPolicy
import com.gradethread.app.sync.RealtimeRows
import com.gradethread.app.sync.SyncService
import com.gradethread.app.sync.db.GradeThreadDb
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.postgrest.from
import io.github.jan.supabase.postgrest.query.Columns
import io.github.jan.supabase.postgrest.query.Order
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * Pre-sync snapshot. The completion summary is computed against it, so the
 * seller sees what the sync actually changed rather than a bare total.
 */
data class EbaySyncBaseline(
    val listings: Int = 0,
    val activeListings: Int = 0,
    val sales: Int = 0,
    val lastSyncedAt: String? = null,
)

/**
 * Outcome of one sync run. The counts are local-cache counts taken after the
 * post-sync pull, not server-emitted totals — the edge endpoint runs detached
 * and returns no counts. A negative delta is real signal (listings ended
 * eBay-side), not an error.
 */
data class EbaySyncSummary(
    val listingsCount: Int = 0,
    val activeListingsCount: Int = 0,
    val salesCount: Int = 0,
    val listingsDelta: Int = 0,
    val salesDelta: Int = 0,
)

/** Terminal state for a sync attempt. */
sealed interface EbaySyncCompletion {
    /** `last_synced_at` advanced and the local pull has settled the cache. */
    data class Completed(val summary: EbaySyncSummary) : EbaySyncCompletion

    /** Polled the whole window with no advance. The job may still be running. */
    data object TimedOut : EbaySyncCompletion

    /** The refresh worker flagged the connection mid-sync (token/scope). */
    data class ConnectionFlagged(val message: String) : EbaySyncCompletion

    /** Network or HTTP failure starting or polling the sync. */
    data class Failed(val message: String) : EbaySyncCompletion
}

/**
 * US-1351: pull eBay listings into the local cache (iOS EbaySyncService).
 *
 * Three steps:
 *  1. snapshot the local counts + `last_synced_at` so the summary can show
 *     deltas;
 *  2. POST `/api/flipdesk/ebay/listings/pull` — the edge returns 202 and runs
 *     the heavy sync detached;
 *  3. poll the PRIMARY connection's `last_synced_at` until it advances past the
 *     snapshot, then run the sync engine so the merged rows are on-device
 *     before the summary counts them.
 */
@Singleton
class EbaySyncService @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
    private val client: SupabaseClient,
    private val db: GradeThreadDb,
    private val syncService: SyncService,
) {

    data class PollingPolicy(
        val intervalMs: Long = 3_000,
        val timeoutMs: Long = 90_000,
    )

    /** What one poll tick saw. */
    @Serializable
    data class ConnectionSnapshot(
        val id: String = "",
        @SerialName("last_synced_at") val lastSyncedAt: String? = null,
        @SerialName("refresh_error") val refreshError: String? = null,
    )

    /** The poll loop's verdict, before the local pull runs. */
    internal sealed interface PollOutcome {
        data object Advanced : PollOutcome
        data object TimedOut : PollOutcome
        data class Flagged(val message: String) : PollOutcome
        data class Failed(val message: String) : PollOutcome
    }

    companion object {
        const val PULL_PATH = "/api/flipdesk/ebay/listings/pull"

        /**
         * Consecutive failed polls before we stop. An unreachable endpoint
         * reported as "timed out" 90 seconds later reads as "eBay is slow" when
         * the truth is the phone lost the network — say which one it was.
         */
        const val MAX_CONSECUTIVE_POLL_FAILURES = 3

        const val LOST_CONNECTION_MESSAGE =
            "Lost connection while syncing — check your network and try again."

        /**
         * True iff the freshly-polled `last_synced_at` is non-null AND strictly
         * newer than the baseline. A null current (connection disappeared
         * mid-sync) is not an advance; a null baseline is a first-ever sync, so
         * any value counts. Pure; unit-tested.
         */
        fun didAdvance(baseline: String?, current: String?): Boolean {
            if (current == null) return false
            if (baseline == null) return true
            if (current == baseline) return false
            val currentMs = RealtimeRows.parseTimestamp(current)
            val baselineMs = RealtimeRows.parseTimestamp(baseline)
            // Both parsed: compare instants, so mixed fractional-second
            // precision between the two reads can't fake an advance.
            if (currentMs != null && baselineMs != null) return currentMs > baselineMs
            return current > baseline
        }

        /**
         * Poll until the cursor advances, the connection is flagged, the
         * endpoint stays unreachable, or the window elapses.
         *
         * Backoff, not a fixed beat: a slow sync must not be polled every three
         * seconds for a minute and a half. In the companion with an injectable
         * clock, sleeper and fetcher, so the whole loop unit-tests with no
         * network and no service instance.
         */
        internal suspend fun pollUntilSynced(
            baseline: EbaySyncBaseline,
            policy: PollingPolicy,
            fetchSnapshot: suspend () -> ConnectionSnapshot?,
            now: () -> Long = System::currentTimeMillis,
            sleeper: suspend (Long) -> Unit = { delay(it) },
        ): PollOutcome {
            val deadline = now() + policy.timeoutMs
            var attempt = 0
            var consecutiveFailures = 0

            while (now() < deadline) {
                sleeper(
                    Backoff.delayMillis(
                        attempt,
                        baseMillis = policy.intervalMs,
                        capMillis = maxOf(policy.intervalMs, 8_000),
                    ),
                )
                attempt += 1

                val snapshot = runCatching { fetchSnapshot() }
                if (snapshot.isFailure) {
                    // runCatching swallows cancellation too — a dismissed sheet
                    // must stop the loop, not count as an unreachable server.
                    (snapshot.exceptionOrNull() as? CancellationException)?.let { throw it }
                    consecutiveFailures += 1
                    val reason = snapshot.exceptionOrNull()?.message.orEmpty()
                    Telemetry.breadcrumb(
                        "eBay sync poll failed ($consecutiveFailures/" +
                            "$MAX_CONSECUTIVE_POLL_FAILURES): $reason",
                        category = "ebay",
                    )
                    if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
                        return PollOutcome.Failed(LOST_CONNECTION_MESSAGE)
                    }
                    continue
                }
                consecutiveFailures = 0 // a reachable server clears the streak

                val row = snapshot.getOrNull()
                // A refresh error outranks the cursor: the connection is broken
                // and the sync did not finish, even if the timestamp moved.
                row?.refreshError?.takeIf { it.isNotBlank() }?.let {
                    return PollOutcome.Flagged(it)
                }
                if (didAdvance(baseline.lastSyncedAt, row?.lastSyncedAt)) {
                    return PollOutcome.Advanced
                }
            }
            return PollOutcome.TimedOut
        }

        /** Summary arithmetic, split out so the deltas are unit-testable. */
        fun summarize(
            baseline: EbaySyncBaseline,
            listings: Int,
            activeListings: Int,
            sales: Int,
        ) = EbaySyncSummary(
            listingsCount = listings,
            activeListingsCount = activeListings,
            salesCount = sales,
            listingsDelta = listings - baseline.listings,
            salesDelta = sales - baseline.sales,
        )
    }

    // ── Public API ───────────────────────────────────────────────────────────

    /** Local counts + the connection cursor, taken right before firing a sync. */
    suspend fun snapshot(): EbaySyncBaseline {
        val (listings, active, sales) = countLocalRows()
        // A FAILED fetch is not a first sync. Treating it as one would let any
        // `last_synced_at` count as an advance, so the very first poll would
        // report success for a sync that had not finished. Breadcrumb it and
        // fall back to null — the run still proceeds.
        val lastSyncedAt = runCatching { fetchSnapshot()?.lastSyncedAt }
            .onFailure {
                Telemetry.breadcrumb(
                    "eBay sync baseline: connection read failed, treating as first sync — " +
                        it.message.orEmpty(),
                    category = "ebay",
                )
            }
            .getOrNull()
        return EbaySyncBaseline(listings, active, sales, lastSyncedAt)
    }

    /**
     * Fire the pull and wait for it. On success the local cache has already
     * been refreshed through [SyncService.pull], so the returned counts are
     * deterministic rather than a hopeful sleep.
     */
    suspend fun sync(
        baseline: EbaySyncBaseline,
        policy: PollingPolicy = PollingPolicy(),
    ): EbaySyncCompletion {
        Telemetry.breadcrumb("eBay sync started", category = "ebay")

        try {
            edge.postRaw(PULL_PATH, "{}")
        } catch (error: EdgeApiError) {
            Telemetry.breadcrumb(
                "eBay sync failed to start: ${error.userMessage()}",
                category = "ebay",
            )
            return EbaySyncCompletion.Failed(error.userMessage())
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            return EbaySyncCompletion.Failed(error.message ?: "Couldn't start sync.")
        }

        return when (val outcome = pollUntilSynced(baseline, policy, { fetchSnapshot() })) {
            is PollOutcome.Advanced -> EbaySyncCompletion.Completed(buildSummary(baseline))
            is PollOutcome.TimedOut -> EbaySyncCompletion.TimedOut
            is PollOutcome.Flagged -> EbaySyncCompletion.ConnectionFlagged(outcome.message)
            is PollOutcome.Failed -> EbaySyncCompletion.Failed(outcome.message)
        }
    }

    // ── Internals ────────────────────────────────────────────────────────────

    /**
     * The PRIMARY connection's row — the same one the edge advances
     * (`/listings/pull` orders `is_primary DESC`). Polling the newest row
     * instead would, for a seller whose primary is not their newest store,
     * watch a cursor nothing is moving and time out on a sync that worked.
     */
    private suspend fun fetchSnapshot(): ConnectionSnapshot? =
        // Named columns, not `*`: this table also holds the encrypted eBay
        // tokens, and there is no reason to pull them onto the device to read a
        // timestamp.
        client.from("marketplace_connections").select(
            Columns.raw("id, last_synced_at, refresh_error"),
        ) {
            filter {
                eq("marketplace", "ebay")
                eq("is_active", true)
            }
            order("is_primary", Order.DESCENDING)
            order("updated_at", Order.DESCENDING)
            limit(1)
        }.decodeList<ConnectionSnapshot>().firstOrNull()

    private suspend fun buildSummary(baseline: EbaySyncBaseline): EbaySyncSummary {
        // Settle the cache against the just-synced server state BEFORE counting.
        syncService.pull()
        val (listings, active, sales) = countLocalRows()
        Telemetry.event(
            "ebay_synced",
            mapOf(
                "listings_total" to listings,
                "sales_total" to sales,
                "listings_delta" to listings - baseline.listings,
                "sales_delta" to sales - baseline.sales,
            ),
        )
        return summarize(baseline, listings, active, sales)
    }

    private suspend fun countLocalRows(): Triple<Int, Int, Int> = Triple(
        db.listings().count(),
        db.listings().countByStatus(ConflictPolicy.liveListingStatuses),
        db.sales().count(),
    )
}
