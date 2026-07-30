package com.gradethread.app.analytics

import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.LocalDate
import java.time.ZoneOffset
import javax.inject.Inject
import javax.inject.Singleton

/**
 * US-1369: loads the anonymized community benchmarks.
 *
 * Straight to the `community_benchmarks` RPC (migration 00173) rather than
 * through an edge route: the function is SECURITY DEFINER, enforces its own
 * k-anonymity floor, and reads `auth.uid()` for the caller's own section, so a
 * route in front of it would add a hop without adding a check.
 */
interface CommunityInsightsProviding {
    suspend fun benchmarks(): CommunityBenchmarks
}

@Singleton
class CommunityInsightsService @Inject constructor(
    private val client: SupabaseClient,
) : CommunityInsightsProviding {

    companion object {
        const val RPC = "community_benchmarks"

        /**
         * Trailing twelve months — the horizon that answers "what should I be
         * sourcing now". Trending categories ignore this and always use the
         * RPC's own last-30-versus-prior-30 window.
         */
        const val WINDOW_DAYS = 365L

        private val json = Json { ignoreUnknownKeys = true }

        /** UTC, because the RPC compares against `current_date` on the server. */
        fun periodStart(today: LocalDate = LocalDate.now(ZoneOffset.UTC)): String =
            today.minusDays(WINDOW_DAYS).toString()
    }

    override suspend fun benchmarks(): CommunityBenchmarks {
        val raw = client.postgrest.rpc(
            function = RPC,
            parameters = JsonObject(mapOf("p_period_start" to JsonPrimitive(periodStart()))),
        ).data
        return json.decodeFromString(CommunityBenchmarks.serializer(), raw)
    }
}
