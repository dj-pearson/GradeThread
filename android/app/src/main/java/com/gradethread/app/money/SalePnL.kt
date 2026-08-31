package com.gradethread.app.money

import com.gradethread.app.ui.UiMessage

import com.gradethread.app.R

import com.gradethread.app.sync.db.SaleEntity

/**
 * Single source of truth for per-sale profit math (iOS
 * GradeThreadCore/SalePnL.swift, the mirror of the web `src/lib/pnl.ts`
 * `computePnl`). EVERY rollup — Home, Money, Sales, Analytics — must net profit
 * through here so the surfaces, the other two clients and the server agree.
 *
 * Definition (matches the eBay sync's stored `net_profit`):
 * ```
 *   revenue = sale_price + shipping_collected
 *   fees    = platform_fees + payment_processing_fees
 *   costs   = shipping_cost + grading_cost + other_costs   (NOT tax)
 *   net     = revenue − fees − costs − cost_basis
 * ```
 *
 * Sales tax is pass-through on a marketplace (collected from the buyer, remitted
 * by eBay), so it is neither revenue nor cost — including it would overstate
 * both sides and inflate revenue on every order.
 */
object SalePnL {

    /**
     * Whether this sale counts toward revenue / profit / sold totals.
     *
     * Cancelled and refunded orders are excluded — migration 00111 requires it
     * of every metric, because a reversed order was never a sale. An empty or
     * unknown status reads as completed: rows predating the status column carry
     * none, and dropping them would erase historical revenue.
     */
    fun isCompleted(sale: SaleEntity): Boolean = sale.status.isBlank() || sale.status == "completed"

    fun revenue(sale: SaleEntity): Double = sale.salePrice + (sale.shippingCollected ?: 0.0)

    fun fees(sale: SaleEntity): Double = sale.platformFees + (sale.paymentProcessingFees ?: 0.0)

    fun sellerCosts(sale: SaleEntity): Double =
        (sale.shippingCost ?: 0.0) + (sale.gradingCost ?: 0.0) + (sale.otherCosts ?: 0.0)

    /** Net profit for one sale given the item's cost basis (acquisition price). */
    fun net(sale: SaleEntity, costBasis: Double): Double = revenue(sale) - fees(sale) - sellerCosts(sale) - costBasis

    /**
     * Display status for the sales list (US-1371 AC2). `pending` is a real 00111
     * state — an order taken but not yet settled — and is shown as such rather
     * than folded into completed, because it does NOT count toward totals.
     */
    fun statusLabel(sale: SaleEntity): UiMessage = when (sale.status) {
        "", "completed" -> UiMessage(R.string.sale_status_completed)
        "pending" -> UiMessage(R.string.sale_status_pending)
        "refunded" -> UiMessage(R.string.sale_status_refunded)
        "cancelled" -> UiMessage(R.string.sale_status_cancelled)
        // Forward-compatible: a status this build doesn't know is shown as
        // itself rather than mislabeled as completed.
        //
        // US-2976: it rides as `detail`, so it is shown exactly as the server
        // named it. Untranslated is the honest outcome for a word we have
        // never seen; inventing a resource for it would not be.
        else -> UiMessage(
            R.string.sale_status_other,
            detail = sale.status.replaceFirstChar { it.uppercase() },
        )
    }
}
