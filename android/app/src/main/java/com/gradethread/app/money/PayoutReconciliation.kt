package com.gradethread.app.money

import com.gradethread.app.sync.db.PayoutEntity
import com.gradethread.app.sync.db.SaleEntity
import kotlin.math.abs

/**
 * US-1365: does what was recorded match what was actually deposited?
 *
 * Entirely local — both sides come from synced Room rows, so this works with
 * no signal and refreshes when the next pull lands. Pure, because it is
 * accounting: a seller acts on these numbers, and "close enough" is not a
 * standard money reporting gets to use.
 */
object PayoutReconciliation {

    /**
     * How far apart two amounts may be and still count as matching.
     *
     * One cent, not zero: sale rows carry dollar decimals and payouts carry
     * integer cents, so a rounding difference of a single cent is arithmetic
     * noise rather than a discrepancy worth a seller's afternoon. Anything
     * larger is real.
     */
    const val TOLERANCE_CENTS = 1

    /** One payout, the sales attributed to it, and whether they agree. */
    data class Reconciled(
        val payout: PayoutEntity,
        val sales: List<SaleEntity>,
        /** What the payout actually deposited. */
        val payoutCents: Int,
        /** What the recorded sales say it should have been. */
        val recordedCents: Int,
        /**
         * True when any contributing sale had no reported payout amount, so
         * its share was ESTIMATED from price minus fees. A mismatch on an
         * estimated total is a weaker claim, and the UI says so.
         */
        val estimated: Boolean,
    ) {
        /** Deposit minus what we recorded. Negative = paid less than expected. */
        val deltaCents: Int get() = payoutCents - recordedCents

        val matched: Boolean get() = abs(deltaCents) <= TOLERANCE_CENTS

        val saleCount: Int get() = sales.size
    }

    /**
     * What one sale should contribute to its payout.
     *
     * Prefers eBay's own reported payout amount. Falls back to price minus
     * platform fees only when that is missing — and flags it, because a
     * fallback compared against a real deposit produces a "mismatch" that is
     * really just our estimate being an estimate.
     */
    fun expectedCents(sale: SaleEntity): Pair<Int, Boolean> {
        val reported = sale.payoutAmount
        if (reported != null) return Money.cents(reported).toCents() to false
        val fallback = sale.salePrice - sale.platformFees
        return Money.cents(fallback).toCents() to true
    }

    private fun Double.toCents(): Int = Math.round(this * 100).toInt()

    /**
     * Reconcile every payout against the sales pointing at it.
     *
     * Matching is on `payoutReference` EXACTLY — eBay's payout id is an opaque
     * string, and case-folding or trimming one side is how a join quietly stops
     * finding anything.
     */
    fun reconcile(payouts: List<PayoutEntity>, sales: List<SaleEntity>): List<Reconciled> {
        val byReference = sales
            .filter { !it.payoutReference.isNullOrBlank() }
            // Cancelled and refunded orders don't belong in a deposit total.
            .filter { it.status == "completed" }
            .groupBy { it.payoutReference!! }

        return payouts.map { payout ->
            val matched = byReference[payout.payoutId].orEmpty()
            var recorded = 0
            var estimated = false
            for (sale in matched) {
                val (cents, wasEstimated) = expectedCents(sale)
                recorded += cents
                if (wasEstimated) estimated = true
            }
            Reconciled(
                payout = payout,
                sales = matched,
                payoutCents = payout.amountCents ?: 0,
                recordedCents = recorded,
                estimated = estimated,
            )
        }.sortedByDescending { it.payout.payoutDate ?: 0L }
    }

    /** Payouts that don't agree with the books — the only ones worth acting on. */
    fun mismatches(reconciled: List<Reconciled>): List<Reconciled> =
        reconciled.filterNot { it.matched }

    /**
     * Sales claiming a payout that isn't on this device.
     *
     * Distinct from a mismatch: nothing is wrong with the numbers, we just
     * haven't got the deposit yet. Saying "unmatched" instead of "missing
     * money" is the difference between a shrug and a support ticket.
     */
    fun salesWithUnknownPayout(
        payouts: List<PayoutEntity>,
        sales: List<SaleEntity>,
    ): List<SaleEntity> {
        val known = payouts.map { it.payoutId }.toSet()
        return sales.filter {
            val reference = it.payoutReference
            // Completed only, to stay consistent with [reconcile] — otherwise a
            // cancelled order would appear here as if money were outstanding.
            it.status == "completed" && !reference.isNullOrBlank() && reference !in known
        }
    }

    /** Completed sales with no payout reference at all — not yet paid out. */
    fun salesAwaitingPayout(sales: List<SaleEntity>): List<SaleEntity> =
        sales.filter { it.status == "completed" && it.payoutReference.isNullOrBlank() }

    // ── wording ──────────────────────────────────────────────────────────────

    fun deltaLabel(entry: Reconciled): String {
        val delta = entry.deltaCents
        val amount = Money.format(abs(delta) / 100.0)
        return when {
            entry.matched -> "Matches your records."
            delta < 0 -> "$amount less than recorded."
            else -> "$amount more than recorded."
        }
    }

    fun summary(reconciled: List<Reconciled>): String {
        if (reconciled.isEmpty()) return "No payouts synced yet."
        val off = mismatches(reconciled).size
        return if (off == 0) {
            "All ${reconciled.size} payouts match your records."
        } else {
            "$off of ${reconciled.size} payouts don't match."
        }
    }

    /** Names an estimate as an estimate, so a soft mismatch isn't read as hard. */
    fun estimateNote(entry: Reconciled): String? =
        if (entry.estimated && !entry.matched) {
            "Some of these sales had no reported payout, so their share was estimated " +
                "from price minus fees."
        } else {
            null
        }
}
