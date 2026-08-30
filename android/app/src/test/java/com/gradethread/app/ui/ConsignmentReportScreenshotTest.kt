package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.consignment.ConsignmentReportContent
import com.gradethread.app.consignment.ConsignmentReportRow
import com.gradethread.app.consignment.ConsignmentReportViewModel
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: a golden over the consignment report.
 *
 * ⚠ THESE FIGURES ARE OWED TO SOMEONE ELSE. Every other money screen in the app
 * misreports the seller's own money to the seller. This one tells the seller
 * what a CONSIGNOR is owed, and the split between `consignorPayout` and
 * `yourCut` is the entire point of a row. Two columns swapping places is a
 * plausible layout regression and an ugly conversation with the person you owe.
 *
 * ⚠ THE TWO SPLITS ARE DELIBERATELY DIFFERENT (60/40 and 50/50) AND THE ROWS
 * ARE NOT PROPORTIONAL. If both rows used one split, a bug that rendered
 * `yourCut` in the payout column would still look plausible - the numbers would
 * be wrong but consistent. With different splits and different gross figures,
 * swapping the columns produces two payouts that no longer match their stated
 * percentages, which is visible.
 *
 * The empty state is its own capture because it is not blank: emptyMessage
 * distinguishes "no consignors yet" from "consignors, but nothing of theirs has
 * sold", and telling a seller the wrong one of those is a support ticket.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class ConsignmentReportScreenshotTest {

    private val rows = listOf(
        // 60/40 in the consignor's favour on 420.00 gross.
        row("c1", "Marguerite Adeyemi", 4, 420.0, 63.0, 214.20, 142.80),
        // 50/50 on a smaller gross, so a swapped column stops matching its split.
        row("c2", "Tomas Lindqvist", 2, 150.0, 22.50, 63.75, 63.75),
    )

    private val loaded = ConsignmentReportViewModel.State(
        rows = rows,
        consignorCount = 2,
        unsoldConsigned = 3,
    )

    @Test
    fun report_light() = capture("screen-consignment-light") {
        ConsignmentReportContent(loaded)
    }

    @Test
    fun report_dark() = capture("screen-consignment-dark", dark = true) {
        ConsignmentReportContent(loaded)
    }

    /** Consignors exist, but nothing of theirs has sold. */
    @Test
    fun nothingSoldYet_light() = capture("screen-consignment-nothingsold-light") {
        ConsignmentReportContent(
            ConsignmentReportViewModel.State(consignorCount = 2, unsoldConsigned = 5),
        )
    }

    /** No consignors at all — a different message, and a different fix. */
    @Test
    fun noConsignors_light() = capture("screen-consignment-noconsignors-light") {
        ConsignmentReportContent(ConsignmentReportViewModel.State())
    }

    /** The failure, with the retry that onRetry exists for. */
    @Test
    fun error_dark() = capture("screen-consignment-error-dark", dark = true) {
        ConsignmentReportContent(
            ConsignmentReportViewModel.State(errorMessage = "Could not reach the server."),
        )
    }

    @Suppress("LongParameterList")
    private fun row(
        id: String,
        name: String,
        itemsSold: Int,
        gross: Double,
        fees: Double,
        payout: Double,
        yours: Double,
    ) = ConsignmentReportRow(
        consignorId = id,
        consignorName = name,
        itemsSold = itemsSold,
        grossRevenue = gross,
        fees = fees,
        netProceeds = gross - fees,
        consignorPayout = payout,
        yourCut = yours,
    )

    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}
