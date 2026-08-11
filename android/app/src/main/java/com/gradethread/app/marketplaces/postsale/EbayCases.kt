package com.gradethread.app.marketplaces.postsale

import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.OffsetDateTime

/**
 * US-2409: eBay's returns, cancellations and payment disputes.
 *
 * These are the three surfaces with a clock on them. Every field name here is
 * the edge's own — the post-order responses are camelCase, unlike the
 * snake_case bodies the same routes take, and renaming either would hide that
 * from anyone comparing the two.
 */

@Serializable
data class EbayReturn(
    val returnId: String = "",
    val state: String? = null,
    /**
     * Always null today. `normalizeReturn` on the edge hardcodes it, so nothing
     * that needs an order id can be offered on a return row — see the partial
     * refund the web has and this screen does not.
     */
    val orderId: String? = null,
    val itemId: String? = null,
    val reason: String? = null,
    val creationDate: String? = null,
)

@Serializable
data class EbayReturnList(val returns: List<EbayReturn> = emptyList())

@Serializable
data class EbayCancellation(
    val cancelId: String = "",
    val state: String? = null,
    val orderId: String? = null,
    val reason: String? = null,
    /** "BUYER" or "SELLER" — who asked. */
    val requestorType: String? = null,
    val creationDate: String? = null,
)

@Serializable
data class EbayCancellationList(val cancellations: List<EbayCancellation> = emptyList())

@Serializable
data class EbayPaymentDispute(
    val paymentDisputeId: String = "",
    val orderId: String? = null,
    val status: String? = null,
    val reason: String? = null,
    val amount: Double? = null,
    val currency: String? = null,
    val openedDate: String? = null,
    /** The one real deadline in this whole feature. */
    val respondByDate: String? = null,
    val buyerUsername: String? = null,
)

@Serializable
data class EbayPaymentDisputeList(val disputes: List<EbayPaymentDispute> = emptyList())

@Serializable
internal data class DecideReturnRequest(
    val decision: String,
    val comments: String? = null,
    @kotlinx.serialization.SerialName("order_id") val orderId: String? = null,
)

@Serializable
internal data class OrderIdRequest(
    @kotlinx.serialization.SerialName("order_id") val orderId: String? = null,
)

@Serializable
internal data class ContestRequest(
    val note: String? = null,
    @kotlinx.serialization.SerialName("order_id") val orderId: String? = null,
)

@Serializable
data class DisputeActionResponse(
    val ok: Boolean = false,
    /** The server checked first and found eBay had already settled it. */
    val alreadyResolved: Boolean = false,
)

@Serializable
data class EvidenceResponse(val ok: Boolean = false, val evidenceId: String? = null)

/**
 * Which post-sale cases still need the seller, and which are history.
 *
 * A direct port of `src/pages/flipdesk/post-sale-state.ts`, guarded by the
 * shared fixture both suites read — a source diff cannot guard a port across
 * languages.
 *
 * **The default is OPEN**, and that asymmetry is the whole point. Calling an
 * open case closed hides work the seller must do before an eBay deadline, with
 * no way for them to discover it. Calling a closed case open shows one extra
 * row whose buttons turn into a no-op. The first costs them a case; the second
 * costs them a glance.
 */
object EbayCases {

    /**
     * Words that appear only in a state eBay considers finished.
     *
     * `REFUND` is deliberately absent on its own: `REFUND_OVERDUE` is an OPEN
     * case and the most urgent kind there is, a refund the seller owes and has
     * not issued. Matching the bare word would bury exactly the row that needs
     * action most.
     */
    private val TERMINAL_MARKERS = listOf(
        "CLOSED", "COMPLETED", "CANCELLED", "CANCELED",
        "DECLINED", "REJECTED", "REFUNDED", "RESOLVED", "FINISHED",
    )

    /**
     * True when the case is finished.
     *
     * Takes both fields because returns and cancellations expose `state` and
     * disputes expose `status` — one rule for all three beats three rules that
     * drift.
     */
    fun isClosed(state: String?, status: String? = null): Boolean {
        val raw = (state ?: status ?: "").uppercase()
        if (raw.isBlank()) return false
        return TERMINAL_MARKERS.any { raw.contains(it) }
    }

    fun isClosed(case: EbayReturn): Boolean = isClosed(case.state)

    fun isClosed(case: EbayCancellation): Boolean = isClosed(case.state)

    fun isClosed(case: EbayPaymentDispute): Boolean = isClosed(null, case.status)

    /**
     * Whole days from now until [iso], negative when it has passed.
     *
     * Ceiling, matching the web: a deadline eleven hours away is "1 day", not
     * "0 days". Rounding it down would tell a seller they had run out of time
     * on a day they could still act.
     */
    fun daysUntil(iso: String?, nowMillis: Long): Long? {
        val at = parseInstant(iso) ?: return null
        val diff = at - nowMillis
        return Math.ceil(diff.toDouble() / 86_400_000.0).toLong()
    }

    /** A deadline that has already passed. Unknown dates are NOT overdue. */
    fun isOverdue(iso: String?, nowMillis: Long): Boolean {
        val days = daysUntil(iso, nowMillis) ?: return false
        return days < 0
    }

    /**
     * Parse an ISO-8601 timestamp, or null.
     *
     * eBay sends both `Z` and offset forms, sometimes with fractional seconds,
     * so this is lenient rather than a fixed pattern. A date the phone cannot
     * read produces no deadline badge at all — better than an "Overdue" label
     * invented from a parse failure.
     */
    fun parseInstant(raw: String?): Long? {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return null
        return runCatching { Instant.parse(text).toEpochMilli() }.getOrNull()
            ?: runCatching { OffsetDateTime.parse(text).toInstant().toEpochMilli() }.getOrNull()
    }
}
