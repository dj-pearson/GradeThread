package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.inventory.AspectConstraint
import com.gradethread.app.inventory.AspectSpecState
import com.gradethread.app.inventory.AspectValueOption
import com.gradethread.app.inventory.EbayAspect
import com.gradethread.app.marketplaces.publish.EbayCondition
import com.gradethread.app.marketplaces.publish.PublishActions
import com.gradethread.app.marketplaces.publish.PublishPhase
import com.gradethread.app.marketplaces.publish.PublishSheetContent
import com.gradethread.app.marketplaces.publish.PublishSummary
import com.gradethread.app.marketplaces.publish.PublishViewModel
import com.gradethread.app.marketplaces.publish.PushResponse
import com.gradethread.app.templates.ListingTemplate
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: the publish sheet, in each of the five phases a seller can land
 * in.
 *
 * WHY PHASES ARE THE RIGHT AXIS HERE. PublishPhase is a sealed interface with a
 * total transition function (PublishFlow.afterValidate maps every outcome to
 * exactly one phase, deliberately, so a new outcome cannot leave the UI
 * spinning). The screen is a `when` over that type, so one golden per branch is
 * complete coverage of the layout rather than a sample of it, and a new phase
 * added without a rendering arm shows up as a missing golden.
 *
 * THE BRANCH THAT MATTERS MOST is Review with blockers. The publish button is
 * off and each blocker names its own fix; a regression that renders blockers as
 * warnings, or leaves the button live, sends a listing to eBay that eBay will
 * reject. That is a round trip through a seller's time, and it is invisible in
 * a unit test of PublishFlow because PublishFlow is right.
 *
 * Published is captured with syncPending true on purpose: it is the state that
 * reads as a failure and is not (live on eBay, local mirror behind - US-783).
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class PublishSheetScreenshotTest {

    private val aspects = listOf(
        EbayAspect(
            localizedAspectName = "Brand",
            aspectConstraint = AspectConstraint(
                aspectMode = "FREE_TEXT",
                aspectRequired = true,
                aspectUsage = "RECOMMENDED",
                itemToAspectCardinality = "SINGLE",
            ),
        ),
        EbayAspect(
            localizedAspectName = "Size Type",
            aspectConstraint = AspectConstraint(
                aspectMode = "SELECTION_ONLY",
                aspectRequired = true,
                itemToAspectCardinality = "SINGLE",
            ),
            aspectValues = listOf(
                AspectValueOption("Regular"),
                AspectValueOption("Petite"),
                AspectValueOption("Plus"),
            ),
        ),
    )

    private fun state(
        phase: PublishPhase = PublishPhase.Composing,
        relist: Boolean = false,
        errorMessage: String? = null,
        specState: AspectSpecState = AspectSpecState.Loaded(aspects, "Women's Jeans"),
        templates: List<ListingTemplate> = emptyList(),
    ) = PublishViewModel.State(
        itemId = "item_fixture",
        loading = false,
        phase = phase,
        title = "Levi's 501 Straight Jean, dark wash, W30 L32",
        priceText = "48.00",
        condition = EbayCondition.USED_EXCELLENT,
        conditionDescription = "Light fading at the collar, no holes or stains.",
        costBasis = 12.50,
        relist = relist,
        specState = specState,
        specifics = mapOf("Brand" to listOf("Levi's")),
        measurements = mapOf("Waist" to 30.0, "Inseam" to 32.0),
        templates = templates,
        errorMessage = errorMessage,
    )

    @Test
    fun composing_light() = capture("screen-publish-composing-light") { Content(state()) }

    @Test
    fun composing_dark() = capture("screen-publish-composing-dark", dark = true) {
        Content(state())
    }

    /**
     * Pre-flight came back with problems. Every line names its own fix, and the
     * publish button must stay off.
     */
    @Test
    fun reviewBlocked_light() = capture("screen-publish-blocked-light") {
        Content(
            state(
                phase = PublishPhase.Review(
                    summary = PublishSummary(
                        title = "Levi's 501 Straight Jean, dark wash, W30 L32",
                        priceValue = "48.00",
                        currency = "USD",
                        quantity = 1,
                        categoryId = "11483",
                    ),
                    blockers = listOf(
                        "Add at least one photo before listing.",
                        "Size Type is required for this category.",
                    ),
                    warnings = listOf("No return policy is set; eBay will use your default."),
                ),
            ),
        )
    }

    /** Pre-flight passed. Same phase, opposite verdict. */
    @Test
    fun reviewPublishable_light() = capture("screen-publish-ready-light") {
        Content(
            state(
                phase = PublishPhase.Review(
                    summary = PublishSummary(
                        title = "Levi's 501 Straight Jean, dark wash, W30 L32",
                        priceValue = "48.00",
                        currency = "USD",
                        quantity = 1,
                        categoryId = "11483",
                    ),
                ),
            ),
        )
    }

    /**
     * Live on eBay, local mirror behind. US-783: this reads as a failure and is
     * not one, so the copy has to say so.
     */
    @Test
    fun publishedSyncPending_light() = capture("screen-publish-published-light") {
        Content(
            state(
                phase = PublishPhase.Published(
                    PushResponse(
                        ok = true,
                        listingId = "v1|123456789012|0",
                        listingUrl = "https://www.ebay.com/itm/123456789012",
                        offerId = "9876543210",
                        sku = "GT-ITEM-FIXTURE",
                        syncPending = true,
                    ),
                ),
            ),
        )
    }

    /** A plan wall is an upgrade route, not a retry. */
    @Test
    fun planLimit_light() = capture("screen-publish-planlimit-light") {
        Content(
            state(phase = PublishPhase.PlanLimit("Your plan allows 25 active listings.")),
        )
    }

    /** A failure IS a retry, so this one gets the back-to-composer button. */
    @Test
    fun failed_light() = capture("screen-publish-failed-light") {
        Content(
            state(
                phase = PublishPhase.Failed("eBay rejected the offer: aspect value too long."),
                errorMessage = "We couldn't publish this listing.",
            ),
        )
    }

    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}

/**
 * Top level for the same reason the other two screenshot files' helpers are: an
 * instance composable on a test class trips ComposeUnstableReceiver.
 *
 * PublishActions is left at its defaults, which is the whole point of giving it
 * defaults - a golden wants the layout and none of the behaviour.
 */
@Composable
private fun Content(state: PublishViewModel.State) {
    PublishSheetContent(
        state = state,
        actions = PublishActions(),
        onOpenListing = {},
        onDismiss = {},
    )
}
