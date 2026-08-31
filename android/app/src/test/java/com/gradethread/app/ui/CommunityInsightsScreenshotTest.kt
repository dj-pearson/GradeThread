package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.R
import com.gradethread.app.analytics.BrandBenchmark
import com.gradethread.app.analytics.CategoryTrend
import com.gradethread.app.analytics.CommunityBenchmarks
import com.gradethread.app.analytics.CommunityInsightsActions
import com.gradethread.app.analytics.CommunityInsightsContent
import com.gradethread.app.analytics.CommunityInsightsViewModel
import com.gradethread.app.analytics.CommunityRecommendation
import com.gradethread.app.analytics.ConfidenceLevel
import com.gradethread.app.analytics.PeerComparison
import com.gradethread.app.analytics.RecommendationKind
import com.gradethread.app.analytics.SellerSummary
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over what other sellers are doing.
 *
 * ⚠ "NOTHING WORTH ACTING ON" AND "NOT ENOUGH DATA" ARE DIFFERENT SENTENCES.
 * Rows exist but none clear the action thresholds is a finished answer; not
 * enough community data is a reason to come back later. Showing the second when
 * the first is true tells a seller to wait for something that already arrived.
 * Both are captured.
 *
 * ⚠ A LOCKED SCREEN IS NOT A FAILED ONE. Locked carries a plan boundary and the
 * server's own sentence; Failed is a fault with a retry. Both render a card
 * with words on it, and only one deserves a support ticket.
 *
 * ⚠ AND A RECOMMENDATION CARRIES ITS OWN CONFIDENCE. The fixture uses three
 * different levels, because a seller acts on these - sourcing decisions and
 * price changes - and a card that rendered every suggestion as high confidence
 * would be advice with the hedging stripped out.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class CommunityInsightsScreenshotTest {

    private val benchmarks = CommunityBenchmarks(
        topBrands = listOf(
            brand("Patagonia", sellers = 41, listed = 220, sold = 168, rate = 0.76, price = 82.0),
            brand("Barbour", sellers = 18, listed = 74, sold = 39, rate = 0.53, price = 190.0),
            // Listed the most and sold the least. The row worth seeing.
            brand("Uniqlo", sellers = 63, listed = 410, sold = 121, rate = 0.30, price = 21.0),
        ),
        trendingCategories = listOf(
            CategoryTrend("Fleece", sellers = 38, soldRecent = 142, soldPrevious = 96, growth = 0.48),
            CategoryTrend("Wax jackets", sellers = 14, soldRecent = 31, soldPrevious = 34, growth = -0.09),
        ),
        you = SellerSummary(
            listed = 41,
            sold = 24,
            sellThrough = 0.59,
            peerComparison = PeerComparison(
                peerCount = 52,
                peerMedianSellThrough = 0.64,
                yourSellThrough = 0.59,
            ),
        ),
    )

    private val recommendations = listOf(
        rec("r1", RecommendationKind.SOURCE, "Patagonia", ConfidenceLevel.HIGH, 0.91, 41, "Patagonia"),
        rec("r2", RecommendationKind.PRICE, "Barbour", ConfidenceLevel.MEDIUM, 0.62, 18, "Barbour"),
        // A category, so brandFilter is null: the local mirror has no category
        // column and a filter would silently match nothing.
        rec("r3", RecommendationKind.SOURCE, "Fleece", ConfidenceLevel.LOW, 0.34, 9, null),
    )

    private val ready = CommunityInsightsViewModel.State(
        phase = CommunityInsightsViewModel.Phase.Ready(benchmarks),
        recommendations = recommendations,
    )

    @Test
    fun insights_light() = capture("screen-community-light") {
        CommunityInsightsContent(ready, CommunityInsightsActions())
    }

    @Test
    fun insights_dark() = capture("screen-community-dark", dark = true) {
        CommunityInsightsContent(ready, CommunityInsightsActions())
    }

    /**
     * Benchmarks exist, and nothing clears the action thresholds. A finished
     * answer - NOT "come back later".
     */
    @Test
    fun nothingWorthActingOn_light() = capture("screen-community-quiet-light") {
        CommunityInsightsContent(
            ready.copy(recommendations = emptyList()),
            CommunityInsightsActions(),
        )
    }

    /** Not enough community data yet. The other empty, and it means waiting. */
    @Test
    fun notEnoughData_light() = capture("screen-community-thin-light") {
        CommunityInsightsContent(
            CommunityInsightsViewModel.State(
                phase = CommunityInsightsViewModel.Phase.Ready(CommunityBenchmarks()),
            ),
            CommunityInsightsActions(),
        )
    }

    /** Still fetching. */
    @Test
    fun loading_light() = capture("screen-community-loading-light") {
        CommunityInsightsContent(CommunityInsightsViewModel.State(), CommunityInsightsActions())
    }

    /** A plan boundary, in the server's own words. Not a fault. */
    @Test
    fun locked_light() = capture("screen-community-locked-light") {
        CommunityInsightsContent(
            CommunityInsightsViewModel.State(
                phase = CommunityInsightsViewModel.Phase.Locked(
                    "Community insights are on Pro and above.",
                ),
            ),
            CommunityInsightsActions(),
        )
    }

    /** An actual failure. Compare with the capture above. */
    @Test
    fun failed_dark() = capture("screen-community-failed-dark", dark = true) {
        CommunityInsightsContent(
            CommunityInsightsViewModel.State(
                phase = CommunityInsightsViewModel.Phase.Failed("Could not reach the server."),
            ),
            CommunityInsightsActions(),
        )
    }

    @Suppress("LongParameterList")
    private fun brand(brand: String, sellers: Int, listed: Int, sold: Int, rate: Double, price: Double) =
        BrandBenchmark(
            brand = brand,
            sellers = sellers,
            listed = listed,
            sold = sold,
            sellThrough = rate,
            avgSalePrice = price,
        )

    @Suppress("LongParameterList")
    private fun rec(
        id: String,
        kind: RecommendationKind,
        subject: String,
        level: ConfidenceLevel,
        confidence: Double,
        cohort: Int,
        brandFilter: String?,
    ) = CommunityRecommendation(
        id = id,
        kind = kind,
        subject = subject,
        // US-2976: the sentences the app actually produces. The old fixture
        // said "Reprice your X" and "Across N sellers, X is moving faster than
        // your listings are." - neither of which any code path generates.
        title = if (kind == RecommendationKind.SOURCE) {
            UiMessage(R.string.community_source_brand_title, args = listOf(subject))
        } else {
            UiMessage(
                R.string.community_price_brand_title,
                args = listOf(subject, "$128.00"),
            )
        },
        detail = UiMessage(
            R.plurals.community_source_detail,
            args = listOf(cohort, "62%"),
            quantity = cohort,
        ),
        confidence = confidence,
        confidenceLevel = level,
        cohortSize = cohort,
        brandFilter = brandFilter,
        // Ranks the card against its siblings. Tied to confidence here so the
        // three cards come out in the order their confidence implies.
        score = confidence,
    )

    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}
