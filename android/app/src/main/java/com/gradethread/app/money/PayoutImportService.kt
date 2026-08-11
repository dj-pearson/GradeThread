package com.gradethread.app.money

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-2414: importing an eBay Seller Hub payouts CSV.
 *
 * **The parsing is the server's, and that is the point.** The dedup rule that
 * stops a second upload of the same export double-counting a deposit lives in
 * `ebay-payout-dedup.ts`, next to the webhook that ingests the same payouts
 * live. A phone that parsed the CSV itself would be a second parser and a
 * second dedup rule, free to disagree with the one the webhook uses — and the
 * disagreement would show up as money that does not add up.
 *
 * The rows land in `payout_imports`, which is what the next sync pulls into
 * Room, so the existing reconciliation reads them without knowing they came
 * from a file.
 */
@Serializable
data class PayoutImportResult(
    /** Rows genuinely new to this account. */
    val imported: Int = 0,
    /** Lines the parser could not read as a payout. */
    val skipped: Int = 0,
    /** Rows already held — the re-import guard, reported rather than hidden. */
    val duplicates: Int = 0,
)

@Singleton
class PayoutImportService @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
) {

    suspend fun importCsv(csv: String): PayoutImportResult = json.decodeFromString(
        PayoutImportResult.serializer(),
        edge.postRaw(PATH, json.encodeToString(CsvBody.serializer(), CsvBody(csv))),
    )

    @Serializable
    private data class CsvBody(val csv: String)

    companion object {
        const val PATH = "/api/flipdesk/ebay/payouts/import-csv"

        /** The server's own soft cap. Checked here so a 5MB upload over a
         *  cellular connection is refused before it is sent, not after. */
        const val MAX_BYTES = 5 * 1024 * 1024

        private val json = Json { ignoreUnknownKeys = true; isLenient = true }

        /**
         * What to show for a failed import.
         *
         * A 400 from this route is the wrong-export message, and it names the
         * exact menu path — Seller Hub → Payments → Payouts → Download. Nothing
         * on the device could work that out, and a seller who picked the orders
         * report instead of the payouts report has no other way to learn which
         * one they needed.
         */
        fun message(error: Throwable): String =
            (error as? EdgeApiError)?.userMessage()
                ?: error.message
                ?: "We couldn't read that file."
    }
}
