package com.gradethread.app.money

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-2489: the SERVER-side payout matcher and its review queue.
 *
 * **This is not the same thing as the local comparison already on this
 * screen.** `PayoutReconciliation` compares two Room tables and works with no
 * signal — that is the offline answer to "do my books agree with my deposits".
 * This is the answer to "they do not, what do I do about it": the server scores
 * candidate sales against each unreconciled payout, auto-matches only the
 * unambiguous ones, and leaves the rest for a person.
 *
 * The two are deliberately kept apart rather than merged. Folding the queue
 * into the offline view would make a screen that silently needs a connection to
 * be right, which is exactly what the local comparison exists to avoid.
 */
@Serializable
data class PayoutCandidate(
    @SerialName("sale_id") val saleId: String = "",
    @SerialName("item_id") val itemId: String = "",
    @SerialName("item_title") val itemTitle: String? = null,
    @SerialName("sale_date") val saleDate: String? = null,
    @SerialName("sale_price") val salePrice: Double? = null,
    @SerialName("payout_amount") val payoutAmount: Double? = null,
    @SerialName("payout_reference") val payoutReference: String? = null,
    /** 0..1. The server's own score; never re-derived here. */
    val score: Double = 0.0,
    /** Why the server thinks so, in its words — shown rather than summarised. */
    val reasons: List<String> = emptyList(),
)

@Serializable
data class QueuedPayout(
    val id: String = "",
    @SerialName("payout_date") val payoutDate: String? = null,
    val amount: Double? = null,
    @SerialName("raw_payload") val rawPayload: Map<String, JsonElement> = emptyMap(),
    @SerialName("created_at") val createdAt: String = "",
)

@Serializable
data class PayoutQueueEntry(
    @SerialName("payout_import") val payout: QueuedPayout = QueuedPayout(),
    val candidates: List<PayoutCandidate> = emptyList(),
)

@Serializable
data class PayoutQueue(
    val queue: List<PayoutQueueEntry> = emptyList(),
    /** Every unreconciled payout, not just the page. */
    val total: Int = 0,
    val showing: Int = 0,
    /**
     * The queue is capped server-side. Reported rather than silently truncated,
     * so a seller with 200 unmatched deposits is told there are more instead of
     * believing they have cleared the list.
     */
    @SerialName("has_more") val hasMore: Boolean = false,
    val limit: Int = 0,
)

@Serializable
data class PayoutSweep(
    @SerialName("auto_matched") val autoMatched: Int = 0,
    /** Scored well but not clearly enough — these stay for a person. */
    val ambiguous: Int = 0,
    @SerialName("no_candidates") val noCandidates: Int = 0,
    val scanned: Int = 0,
)

@Serializable
private data class MatchRequest(
    @SerialName("payout_import_id") val payoutImportId: String,
    @SerialName("sale_id") val saleId: String,
)

@Singleton
class PayoutQueueService @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
) {

    suspend fun queue(): PayoutQueue =
        json.decodeFromString(PayoutQueue.serializer(), edge.getRaw(QUEUE_PATH))

    /**
     * Sweep the unreconciled payouts and auto-match the unambiguous ones.
     *
     * The thresholds are the server's and are deliberately tight: anything that
     * does not clearly beat its alternatives stays queued. A queued row someone
     * has to tap is a far better outcome than a silent wrong link in the books.
     */
    suspend fun run(): PayoutSweep =
        json.decodeFromString(PayoutSweep.serializer(), edge.postRaw(RUN_PATH, "{}"))

    suspend fun match(payoutImportId: String, saleId: String) {
        edge.postRaw(
            MATCH_PATH,
            json.encodeToString(
                MatchRequest.serializer(),
                MatchRequest(payoutImportId, saleId),
            ),
        )
    }

    /**
     * Take a payout out of the queue without linking it to a sale.
     *
     * The row is marked reconciled with a `dismissed_at` marker rather than
     * deleted — a refund-only deposit, or one for a sale made outside FlipDesk,
     * is still a real thing that happened to the seller's money.
     */
    suspend fun dismiss(payoutImportId: String) {
        edge.postRaw("$DISMISS_PATH/$payoutImportId", "{}")
    }

    companion object {
        private const val BASE = "/api/flipdesk/reconciliation"
        const val QUEUE_PATH = "$BASE/queue"
        const val RUN_PATH = "$BASE/run"
        const val MATCH_PATH = "$BASE/match"
        const val DISMISS_PATH = "$BASE/dismiss"

        private val json = Json { ignoreUnknownKeys = true; isLenient = true }

        /**
         * A 409 means the sale or the payout is already linked somewhere else,
         * and the server says so in words that name the fix ("un-match first").
         * Anything generic here would leave the seller re-tapping a button that
         * cannot work.
         */
        fun message(error: Throwable): String =
            (error as? EdgeApiError)?.userMessage()
                ?: error.message
                ?: "We couldn't reach the matcher just now."
    }
}
