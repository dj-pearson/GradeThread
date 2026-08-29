package com.gradethread.app.ui

import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.gradethread.app.marketplaces.publish.EbayCondition
import com.gradethread.app.marketplaces.publish.PublishActions
import com.gradethread.app.marketplaces.publish.PublishPhase
import com.gradethread.app.marketplaces.publish.PublishSheetContent
import com.gradethread.app.marketplaces.publish.PublishSummary
import com.gradethread.app.marketplaces.publish.PublishViewModel
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * US-2891 AC4: does the publish surface draw under the status or navigation bar
 * on API 36?
 *
 * WHY THIS SAT OPEN, AND WHAT CHANGED. AC4's other surfaces were walked by hand
 * on the emulator and measured clear. Publish could not be: reaching it needs a
 * signed-in account with an item in it, and signup cannot complete on a host
 * with no readable inbox. The story's note left it "for whoever next has a
 * signed-in device" and recorded a strong inference in the meantime.
 *
 * An inference was the right thing to record and it is not what the criterion
 * asks for. US-2902 AC3 extracted PublishSheetContent out of the ViewModel, so
 * the surface composes on a real device with no account, no network and no Hilt
 * graph. The wrapper here is the REAL ModalBottomSheet rather than a stand-in,
 * because the sheet is the component whose inset handling is in question.
 *
 * WHAT IT ASSERTS. Edge-to-edge is on, so the window extends behind the system
 * bars by design and a background under them is correct. What must never happen
 * is TEXT landing there: unreadable at best, and at worst a publish button under
 * the gesture bar.
 */
@RunWith(AndroidJUnit4::class)
class PublishSheetInsetTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val state = PublishViewModel.State(
        itemId = "item_inset_fixture",
        loading = false,
        phase = PublishPhase.Review(
            summary = PublishSummary(
                title = "Levi's 501 Straight Jean",
                priceValue = "48.00",
                currency = "USD",
                quantity = 1,
            ),
            blockers = listOf("Add at least one photo before listing."),
        ),
        title = "Levi's 501 Straight Jean, dark wash, W30 L32",
        priceText = "48.00",
        condition = EbayCondition.USED_EXCELLENT,
        conditionDescription = "Light fading at the collar.",
        relist = false,
    )

    /**
     * THE REAL ANSWER TO AC4. Empty means no text is under a bar.
     */
    @Test
    fun publishSheetKeepsItsTextClearOfTheSystemBars() {
        val probe = offendersFor(zeroInsets = false)
        assertTrue(
            "Publish sheet text drew under a system bar:\n" +
                probe.offenders.joinToString("\n"),
            probe.offenders.isEmpty(),
        )
    }

    /**
     * ⚠ THE SELF-CHECK, and it is not ceremony.
     *
     * The tolerance below was introduced because the first run of the test above
     * failed on ONE node - the sheet title, one pixel into a 128px status bar.
     * That was the assertion being wrong, not the UI: a Compose text node's
     * bounds are the LINE BOX, whose ascent leading sits above the tallest
     * glyph, so a line correctly placed flush against an inset reports a top a
     * few pixels inside it.
     *
     * Widening a guard until it goes green is exactly how a guard stops
     * guarding, so the widening has to be paid for. This case zeroes the sheet's
     * content insets - the precise regression a careless edit would introduce -
     * and requires the check to FIRE. If someone later raises the tolerance far
     * enough to hide a real overlap, this test goes red first.
     */
    @Test
    fun theCheckStillCatchesASheetThatIgnoresTheInsets() {
        val probe = offendersFor(zeroInsets = true)

        // ⚠ ONLY MEANINGFUL WHERE THE BARS ARE DEEPER THAN THE TOLERANCE.
        //
        // Zeroing the insets moves content up by barTop. If barTop is not
        // itself larger than tolerancePx then nothing crosses the line, and the
        // sabotage is undetectable BY CONSTRUCTION rather than because the
        // check is broken. It failed on CI for exactly that reason: a 128px
        // status bar on the local API 36 emulator, a smaller one on the runner.
        // A red run there said nothing about the check it was guarding, and it
        // reset US-2902 AC6's consecutive-green count for no reason.
        assumeTrue(
            "system bars (top " + probe.barTop + ") are not deeper than the " +
                tolerancePx.toInt() + "px tolerance, so this sabotage cannot be seen here",
            probe.barTop > tolerancePx,
        )

        assertTrue(
            "Zeroing the sheet's content insets produced NO offenders, so the " +
                "check above cannot detect a real inset regression either.",
            probe.offenders.isNotEmpty(),
        )
    }

    /**
     * More than this many pixels of a text node under a bar counts as drawn
     * under it. Four pixels at this density is under a third of a millimetre and
     * cannot hide a glyph; it covers the line-box leading described above and
     * nothing larger. The self-check proves it is not covering a real overlap.
     */
    private val tolerancePx = 4f

    @OptIn(ExperimentalMaterial3Api::class)
    private fun offendersFor(zeroInsets: Boolean): Probe {
        rule.activityRule.scenario.onActivity { it.enableEdgeToEdge() }

        rule.setContent {
            GradeThreadTheme {
                Sheet(zeroInsets) {
                    PublishSheetContent(
                        state = state,
                        actions = PublishActions(),
                        onOpenListing = {},
                        onDismiss = {},
                    )
                }
            }
        }
        rule.waitForIdle()

        var barTop = 0
        var barBottom = 0
        var windowHeight = 0
        rule.activityRule.scenario.onActivity { activity ->
            val decor = activity.window.decorView
            windowHeight = decor.height
            val bars = ViewCompat.getRootWindowInsets(decor)
                ?.getInsets(WindowInsetsCompat.Type.systemBars())
            barTop = bars?.top ?: 0
            barBottom = bars?.bottom ?: 0
        }

        // Not a pass: a device reporting no system bars cannot answer the
        // question, and going green there would be a lie.
        assumeTrue(
            "system bar insets came back zero - nothing to check on this device",
            barTop > 0 || barBottom > 0,
        )

        val navBarTop = windowHeight - barBottom
        val offenders = rule.onAllNodes(
            SemanticsMatcher.keyIsDefined(SemanticsProperties.Text),
            useUnmergedTree = true,
        )
            .fetchSemanticsNodes()
            .filter { node ->
                val b = node.boundsInWindow
                if (b.height <= 0f) {
                    false // off-screen list children are not drawn
                } else {
                    val underStatus = barTop - b.top
                    val underNav = b.bottom - navBarTop
                    underStatus > tolerancePx || underNav > tolerancePx
                }
            }
            .map { node ->
                val text = node.config.getOrNull(SemanticsProperties.Text)
                    ?.joinToString(" ") { it.text }
                    .orEmpty()
                "\"" + text + "\" at " + node.boundsInWindow +
                    " (status bar 0..$barTop, nav bar $navBarTop..$windowHeight)"
            }
        return Probe(offenders, barTop)
    }

    /**
     * What a run saw, and the inset that decides whether it could see anything.
     */
    private data class Probe(val offenders: List<String>, val barTop: Int)
}

/**
 * The sheet under test. [zeroInsets] is the sabotage the self-check needs and is
 * never true in the real app.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Sheet(zeroInsets: Boolean, content: @Composable () -> Unit) {
    // ONE ModalBottomSheet call, with the sabotage expressed as a value. An
    // earlier version branched and called content() in both arms, which detekt's
    // ContentSlotReused refused - correctly: a slot invoked from two branches
    // loses its internal state when the branch flips.
    ModalBottomSheet(
        onDismissRequest = {},
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        contentWindowInsets = {
            if (zeroInsets) WindowInsets(0, 0, 0, 0) else BottomSheetDefaults.windowInsets
        },
    ) { content() }
}
