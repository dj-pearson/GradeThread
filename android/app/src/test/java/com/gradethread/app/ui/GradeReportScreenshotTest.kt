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
     * US-3004: the AMBER band, in DARK, and it exists to make a claim true.
     *
     * GradeColor.kt argues that green, amber and red stay literal because they
     * carry on both surfaces - and when that was written, amber had not been
     * checked on a dark golden. Nothing in the repo rendered a 5.0-6.9 grade in
     * dark: this fixture is 8.5 and the AI-fill fixtures are both under 0.5, so
     * they draw red.
     *
     * ⚠ US-3010 CORRECTS THIS COMMENT, which used to add "green had been checked
     * on a dark golden". A green had been. Not THIS green: the one that was
     * checked is the "Certificate verified" badge, a different element with a
     * different value. gradeColor's own emerald band appeared in no capture at
     * all until poorGrade/pristineGrade below. The sentence was true of a green
     * and read as though it settled the grade ladder, which is the same failure
     * it was written to fix.
     *
     * A comment asserting something no capture shows is the same failure as a
     * golden nobody opens. This is the capture.
     */
    @Test
    fun midGrade_dark() = capture("screen-gradereport-amber-dark", dark = true) {
        Content(
            state().copy(
                loaded = loaded("https://gradethread.com/verify/GT-FIXTURE-0001")
                    .copy(report = report.copy(overallScore = 6.0, gradeTier = "Fair")),
            ),
        )
    }

    /**
     * US-3010: the POOR band, which no capture in this repo had ever shown.
     *
     * When this was written gradeColor had FOUR bands and only two were rendered
     * anywhere: 8.5 and 7.0 were Steel Navy, 6.0 Amber. Emerald (>= 9.5) and
     * Crimson (< 5.0) were in NO golden, light or dark, across every screenshot
     * test. That is why the wrong red survived in GradeColor.kt - US-3004 caught
     * the navy band because a dark golden had been showing it, and this band had
     * nothing to show.
     *
     * ⚠ THE LADDER IS THREE BANDS NOW (US-3010 AC6, 2026-09-04) and the navy one
     * is gone, so 8.5 and 7.0 render EMERALD here. This capture matters more
     * rather than less: two of the three bands now share the same fixtures, and
     * the poor band is still the only place Crimson is drawn at all.
     *
     * The factor scores move with the overall score deliberately. A 3.5 report
     * with 8.5 fabric condition is incoherent, and an incoherent fixture invites
     * the next reader to file it as a bug rather than read it as a fixture.
     */
    @Test
    fun poorGrade_light() = capture("screen-gradereport-poor-light") {
        Content(state().copy(loaded = poor()))
    }

    @Test
    fun poorGrade_dark() = capture("screen-gradereport-poor-dark", dark = true) {
        Content(state().copy(loaded = poor()))
    }

    /** US-3010: the PRISTINE band, likewise never captured before now. */
    @Test
    fun pristineGrade_light() = capture("screen-gradereport-pristine-light") {
        Content(state().copy(loaded = pristine()))
    }

    @Test
    fun pristineGrade_dark() = capture("screen-gradereport-pristine-dark", dark = true) {
        Content(state().copy(loaded = pristine()))
    }

    private fun poor() = loaded("https://gradethread.com/verify/GT-FIXTURE-0001")
        .copy(
            report = report.copy(
                overallScore = 3.5,
                gradeTier = "Poor",
                fabricConditionScore = 3.5,
                structuralIntegrityScore = 4.0,
                cosmeticAppearanceScore = 3.0,
                functionalElementsScore = 4.0,
                odorCleanlinessScore = 3.5,
                aiSummary = "Heavy fading throughout with a split seam at the left " +
                    "underarm and a persistent musty odor. Wearable, but the damage " +
                    "is structural rather than cosmetic.",
            ),
            defects = listOf(
                GradeDefect(
                    defect = "Split seam",
                    severity = "major",
                    location = "Left underarm",
                    impactOnGrade = "Structural",
                ),
                GradeDefect(
                    defect = "Persistent odor",
                    severity = "major",
                    location = "Throughout",
                    impactOnGrade = "Requires cleaning",
                ),
            ),
        )

    private fun pristine() = loaded("https://gradethread.com/verify/GT-FIXTURE-0001")
        .copy(
            report = report.copy(
                overallScore = 9.8,
                gradeTier = "Pristine",
                fabricConditionScore = 10.0,
                structuralIntegrityScore = 9.5,
                cosmeticAppearanceScore = 9.5,
                functionalElementsScore = 10.0,
                odorCleanlinessScore = 10.0,
                aiSummary = "No wear detected. Original hem intact, hardware " +
                    "unmarked, and no odor. Presents as unworn.",
            ),
            defects = emptyList(),
        )

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
