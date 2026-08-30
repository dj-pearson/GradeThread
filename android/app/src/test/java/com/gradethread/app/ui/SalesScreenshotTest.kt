package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.money.SaleRow
import com.gradethread.app.money.SalesActions
import com.gradethread.app.money.SalesContent
import com.gradethread.app.money.SalesSummary
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: a golden over the sales list.
 *
 * ⚠ THE FIXTURE CARRIES THE ONE RULE THIS SCREEN EXISTS TO KEEP. SalesRollup's
 * header states it: the LIST shows every sale including refunded and cancelled,
 * because hiding them would make a seller's history disagree with their eBay
 * account - but the TOTALS count only completed ones, because a reversed order
 * was never revenue. So the fixture holds three completed rows and one refunded,
 * and the refunded row's revenue is deliberately NOT in realizedRevenue.
 *
 * A capture is the right guard for that. The rule is invisible in a unit test on
 * the arithmetic alone - the numbers agree with themselves either way. What a
 * reader has to be able to see is a row on screen whose money is not in the
 * total above it.
 *
 * ⚠ AND ONE ROW HAS NO COST BASIS, on purpose. SaleRow.roi returns null when
 * costBasis is zero, and the comment beside it says to show an em dash rather
 * than 0% - a 0% ROI is a claim, and "we do not know" is the truth. That branch
 * has no other coverage.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class SalesScreenshotTest {

    private val aug = 1_756_000_000_000L

    private val rows = listOf(
        row("s1", "Levi's 501 Straight Jean", 78.0, 11.70, 24.0, "Completed", true),
        row("s2", "Barbour Bedale Wax Jacket", 210.0, 31.50, 90.0, "Completed", true),
        // No cost basis recorded: ROI must read as an em dash, never 0%.
        row("s3", "Uniqlo Oxford Shirt", 22.0, 3.30, 0.0, "Completed", true),
        // Shown, NOT summed. Its 64.00 must not appear in the total above.
        row("s4", "Patagonia Better Sweater", 64.0, 9.60, 30.0, "Refunded", false),
    )

    private val summary = SalesSummary(
        rows = rows,
        completedCount = 3,
        excludedCount = 1,
        realizedRevenue = 310.0,
        realizedProfit = 167.5,
    )

    @Test
    fun sales_light() = capture("screen-sales-light") {
        SalesContent(summary, refreshing = false, refreshError = null, actions = SalesActions())
    }

    /** Money on the dark surface, where a mistinted figure hides best. */
    @Test
    fun sales_dark() = capture("screen-sales-dark", dark = true) {
        SalesContent(summary, refreshing = false, refreshError = null, actions = SalesActions())
    }

    /** Nothing sold yet — what a new seller meets. */
    @Test
    fun empty_light() = capture("screen-sales-empty-light") {
        SalesContent(SalesSummary(), refreshing = false, refreshError = null, actions = SalesActions())
    }

    /** A stale list, and the only thing saying so. */
    @Test
    fun refreshError_dark() = capture("screen-sales-refresherror-dark", dark = true) {
        SalesContent(
            summary,
            refreshing = false,
            refreshError = "Could not reach the server.",
            actions = SalesActions(),
        )
    }

    @Suppress("LongParameterList")
    private fun row(
        id: String,
        title: String,
        revenue: Double,
        fees: Double,
        costBasis: Double,
        statusLabel: String,
        counts: Boolean,
    ) = SaleRow(
        saleId = id,
        itemId = "i-$id",
        title = title,
        saleDateMs = aug,
        revenue = revenue,
        fees = fees,
        costBasis = costBasis,
        netProfit = revenue - fees - costBasis,
        statusLabel = statusLabel,
        countsTowardTotals = counts,
    )

    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}
