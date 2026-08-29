package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.grading.CertVerification
import com.gradethread.app.grading.GradeDefect
import com.gradethread.app.grading.GradeReportContent
import com.gradethread.app.grading.GradeReportDto
import com.gradethread.app.grading.GradeReportViewModel
import com.gradethread.app.grading.LoadedGradeReport
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: the first of the six named screens to get a golden, because it
 * is the first to have a stateless half to point one at.
 *
 * GradeReportContent takes a plain State and four lambdas, so these captures
 * need no Hilt graph, no repository and no network. That is the whole point of
 * the extraction in GradeReportScreen.kt, and this file is the thing that would
 * be impossible without it.
 *
 * WHAT THESE GOLDENS ARE ACTUALLY GUARDING. The grade report is the one screen
 * a buyer may be shown, and three of its elements are conditional on state that
 * no smoke test reaches: the share CTA appears only for a certified grade whose
 * integrity check PASSED, the pending-review notice replaces it entirely, and a
 * TAMPERED verdict must not offer sharing at all. Those branches are one
 * boolean apart in the source and visually unmistakable in a PNG.
 *
 * ⚠ WHY createdAt IS null AND NOT A REAL DATE. The dispute button's label is
 * "N days left" while the window is open, and N is computed against
 * System.currentTimeMillis(). A recent fixed timestamp therefore produces a
 * DIFFERENT golden every day, and an old one hides the button forever. Null is
 * the third door: GradeDisputeWindow.isOpen fails OPEN on an unparseable
 * timestamp, and daysRemaining returns null, so the button renders with its
 * static label and the capture is stable. The day-count variant is genuinely
 * uncapturable until the clock is injectable, and pretending otherwise would
 * produce a golden that goes red at midnight.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class GradeReportScreenshotTest {

    private val report = GradeReportDto(
        id = "rep_fixture",
        overallScore = 8.5,
        gradeTier = "Excellent",
        fabricConditionScore = 8.5,
        structuralIntegrityScore = 9.0,
        cosmeticAppearanceScore = 8.0,
        functionalElementsScore = 9.0,
        odorCleanlinessScore = 8.5,
        aiSummary = "Light overall wear with strong seams and no odor. " +
            "One small mark at the left cuff and slight fading at the collar.",
        confidenceScore = 0.91,
        certificateId = "GT-FIXTURE-0001",
        createdAt = null,
    )

    private val defects = listOf(
        GradeDefect(
            defect = "Small stain",
            severity = "minor",
            location = "Left cuff",
            impactOnGrade = "Cosmetic only",
        ),
        GradeDefect(
            defect = "Fading",
            severity = "minor",
            location = "Collar",
            impactOnGrade = "Cosmetic only",
        ),
    )

    private fun loaded(certificateUrl: String?) = LoadedGradeReport(
        report = report,
        defects = defects,
        certificateUrl = certificateUrl,
        itemTitle = "Levi's 501 Straight Jean",
    )

    private fun state(
        certificateUrl: String? = "https://gradethread.com/verify/GT-FIXTURE-0001",
        verification: CertVerification = CertVerification.Verified(signed = true),
        confidence: Double = 0.91,
    ) = GradeReportViewModel.State(
        itemId = "item_fixture",
        loading = false,
        loaded = loaded(certificateUrl).copy(report = report.copy(confidenceScore = confidence)),
        verification = verification,
    )

    @Test
    fun verifiedAndShareable_light() = capture("screen-gradereport-verified-light") {
        Content(state())
    }

    @Test
    fun verifiedAndShareable_dark() = capture("screen-gradereport-verified-dark", dark = true) {
        Content(state())
    }

    /**
     * No certificate and a confidence under the review threshold. The share CTA
     * and the integrity badge both disappear, replaced by the notice.
     */
    @Test
    fun pendingReview_light() = capture("screen-gradereport-pending-light") {
        Content(state(certificateUrl = null, confidence = 0.60))
    }

    /**
     * The claims do not hash to the sealed value. A certificate exists, so this
     * is NOT pending review, but canShare is false and the screen must say why
     * rather than quietly dropping a button.
     */
    @Test
    fun tampered_light() = capture("screen-gradereport-tampered-light") {
        Content(state(verification = CertVerification.Tampered))
    }

    @Test
    fun failedToLoad_light() = capture("screen-gradereport-error-light") {
        Content(
            GradeReportViewModel.State(
                itemId = "item_fixture",
                loading = false,
                errorMessage = "We couldn't reach the grading service.",
            ),
        )
    }

    /**
     * Same shape as ScreenScreenshotTest.capture, deliberately: the two files
     * must not disagree about what a golden is a picture of.
     */
    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}

/**
 * TOP LEVEL, not a method on the test class, and it took two lint errors to get
 * here. As an expression-bodied member it tripped ComposableNaming, because an
 * expression body gives a composable a return type and those must start
 * lowercase. As a block-bodied member it tripped ComposeUnstableReceiver: an
 * instance composable on a non-stable class recomposes every time.
 *
 * A test class is never going to be @Stable, so the receiver is the problem and
 * a file-level function is the fix. Worth writing down because a screenshot
 * helper is the natural thing to tuck inside the class that uses it.
 */
@Composable
private fun Content(state: GradeReportViewModel.State) {
    GradeReportContent(
        state = state,
        onClose = {},
        onDispute = {},
        onRetryLoad = {},
        onRetryVerify = {},
    )
}
