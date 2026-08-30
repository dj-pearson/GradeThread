package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.money.PayoutCandidate
import com.gradethread.app.money.PayoutImportResult
import com.gradethread.app.money.PayoutQueue
import com.gradethread.app.money.PayoutQueueEntry
import com.gradethread.app.money.PayoutReconciliation
import com.gradethread.app.money.PayoutReconciliationActions
import com.gradethread.app.money.PayoutReconciliationContent
import com.gradethread.app.money.PayoutReconciliationViewModel
import com.gradethread.app.money.PayoutSweep
import com.gradethread.app.money.QueuedPayout
import com.gradethread.app.sync.db.PayoutEntity
import com.gradethread.app.sync.db.SaleEntity
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over what eBay actually deposited.
 *
 * ⚠ FOUR BUCKETS, FOUR DIFFERENT ANSWERS, AND ONLY ONE IS A PROBLEM:
 *
 *   mismatches     eBay paid an amount the books did not expect
 *   awaitingPayout sold, not paid yet - eBay is holding it, nothing is wrong
 *   unknownPayout  paid, but the deposit has not synced to THIS device
 *   matched        agreed
 *
 * Every one of them is a sale with no money next to it, so a heading that
 * stops rendering, or a list that lands under its neighbour's heading, turns
 * "eBay has not paid out yet" into "money is missing". The seller opens a
 * support ticket over a payout that was never late. Only the headings tell the
 * four apart, and only a capture can see a heading.
 *
 * ⚠ THE ESTIMATED FLAG IS THE SECOND REASON. A mismatch computed from price
 * minus fees, because eBay reported no payout amount, is a weaker claim than a
 * mismatch between two reported figures. One fixture row carries `estimated`
 * so that the hedge has a golden of its own.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class PayoutReconciliationScreenshotTest {

    private val aug = 1_756_000_000_000L

    /**
     * eBay deposited $8.40 less than the sale in it says it should have.
     *
     * ONE sale, deliberately. Two of these cards fill a Pixel 5 on their own,
     * and the first recording of this test pushed three of the four headings
     * off the bottom - a golden that showed only the bucket it opened on while
     * its own comment claimed to cover four.
     */
    private val mismatch = PayoutReconciliation.Reconciled(
        payout = payout("p1", 12_060),
        sales = listOf(sale("s1", 129.00, 18.90)),
        payoutCents = 12_060,
        recordedCents = 12_900,
        estimated = false,
    )

    /** The same shape, but the total was ESTIMATED. A weaker claim, said so. */
    private val estimatedMismatch = PayoutReconciliation.Reconciled(
        payout = payout("p2", 6_100),
        sales = listOf(sale("s3", 78.00, 11.70, payoutAmount = null)),
        payoutCents = 6_100,
        recordedCents = 6_630,
        estimated = true,
    )

    private val agreed = PayoutReconciliation.Reconciled(
        payout = payout("p3", 18_920),
        sales = listOf(sale("s4", 210.00, 20.80)),
        payoutCents = 18_920,
        recordedCents = 18_920,
        estimated = false,
    )

    private val full = PayoutReconciliationViewModel.State(
        reconciled = listOf(mismatch, agreed),
        mismatches = listOf(mismatch),
        matched = listOf(agreed),
        // Sold, eBay has not paid yet. NOT a problem.
        awaitingPayout = listOf(sale("s5", 64.00, 9.60)),
        // Paid, but this phone has not seen the deposit row. Also not a problem.
        unknownPayout = listOf(sale("s6", 45.00, 6.75)),
    )

    @Test
    fun allFourBuckets_light() = capture("screen-payouts-light") {
        PayoutReconciliationContent(full, PayoutReconciliationActions())
    }

    @Test
    fun allFourBuckets_dark() = capture("screen-payouts-dark", dark = true) {
        PayoutReconciliationContent(full, PayoutReconciliationActions())
    }

    /** Nothing reconciled yet. Must not read as a failure. */
    @Test
    fun empty_light() = capture("screen-payouts-empty-light") {
        PayoutReconciliationContent(
            PayoutReconciliationViewModel.State(),
            PayoutReconciliationActions(),
        )
    }

    /**
     * The SERVER queue, loaded. It is deliberately below the local comparison
     * because this half needs a connection and that half does not - so the
     * capture has to show both at once for the split to be checkable.
     *
     * `hasMore` is set: a seller with more unmatched deposits than we showed
     * must not think the list they can see is the whole list.
     */
    @Test
    fun serverQueue_light() = capture("screen-payouts-queue-light") {
        PayoutReconciliationContent(
            full.copy(
                queue = PayoutQueue(
                    queue = listOf(
                        PayoutQueueEntry(
                            payout = QueuedPayout(id = "q1", payoutDate = "2026-08-14", amount = 92.40),
                            candidates = listOf(
                                PayoutCandidate(
                                    saleId = "s7",
                                    itemId = "i7",
                                    itemTitle = "Barbour Bedale Wax Jacket",
                                    // The server's own reasons, shown as written.
                                    reasons = listOf("amount within $0.50", "sold 3 days before"),
                                    score = 0.91,
                                ),
                            ),
                        ),
                        // Nothing to offer. The honest empty case inside the queue.
                        PayoutQueueEntry(
                            payout = QueuedPayout(id = "q2", payoutDate = "2026-08-11", amount = 15.00),
                        ),
                    ),
                    total = 24,
                    showing = 2,
                    hasMore = true,
                ),
            ),
            PayoutReconciliationActions(),
        )
    }

    /**
     * An import that found duplicates. `duplicates` is the count that matters:
     * a seller who re-uploaded the same export needs telling nothing was
     * counted twice, or they go looking for money that was never missing.
     */
    @Test
    fun importedWithDuplicates_dark() = capture("screen-payouts-imported-dark", dark = true) {
        PayoutReconciliationContent(
            full.copy(
                importResult = PayoutImportResult(imported = 6, duplicates = 11, skipped = 2),
                sweep = PayoutSweep(autoMatched = 4, ambiguous = 2, noCandidates = 1, scanned = 7),
            ),
            PayoutReconciliationActions(),
        )
    }

    /**
     * The estimated hedge, on its own so it is not competing for height. eBay
     * reported no payout amount for this sale, so the share was worked out from
     * price minus fees - a weaker claim than a gap between two reported
     * figures, and the card says so in as many words.
     */
    @Test
    fun estimatedMismatch_light() = capture("screen-payouts-estimated-light") {
        PayoutReconciliationContent(
            PayoutReconciliationViewModel.State(
                reconciled = listOf(estimatedMismatch),
                mismatches = listOf(estimatedMismatch),
            ),
            PayoutReconciliationActions(),
        )
    }

    /** The failure, over the top of real rows. */
    @Test
    fun error_dark() = capture("screen-payouts-error-dark", dark = true) {
        PayoutReconciliationContent(
            full.copy(errorMessage = "Could not reach eBay."),
            PayoutReconciliationActions(),
        )
    }

    private fun payout(id: String, cents: Int) = PayoutEntity(
        id = id,
        payoutId = "EBAY-$id",
        amountCents = cents,
        currency = "USD",
        status = "PAID",
        payoutDate = aug,
        transactionCount = 2,
        updatedAt = aug,
    )

    private fun sale(id: String, price: Double, fees: Double, payoutAmount: Double? = price - fees) = SaleEntity(
        id = id,
        inventoryItemId = "i-$id",
        listingId = null,
        salePrice = price,
        platformFees = fees,
        paymentProcessingFees = null,
        shippingCollected = null,
        shippingCost = null,
        gradingCost = null,
        otherCosts = null,
        tax = null,
        netProfit = price - fees,
        buyerUsername = "buyer_$id",
        platformOrderId = "ORD-$id",
        payoutReference = "EBAY-p1",
        payoutAmount = payoutAmount,
        saleDate = aug,
        soldAt = aug,
        shippedAt = null,
        trackingNumber = null,
        createdAt = aug,
    )

    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}
