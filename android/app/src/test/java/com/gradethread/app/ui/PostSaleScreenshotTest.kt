package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.marketplaces.postsale.PostSaleActions
import com.gradethread.app.marketplaces.postsale.PostSaleContent
import com.gradethread.app.marketplaces.postsale.PostSaleUiState
import com.gradethread.app.marketplaces.postsale.PostSaleViewModel
import com.gradethread.app.sync.db.SaleEntity
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: a golden over what happens after the sale.
 *
 * ⚠ THIS SCREEN IS A CLOCK, which is why it was picked ahead of the 40-odd
 * still waiting. Its two lists are things the seller owes someone else and is
 * being TIMED on - parcels to ship, buyers to thank - and the button behind it
 * opens returns and disputes with real deadlines. A list that renders empty
 * when it is not does not inconvenience the seller; it runs their clock down
 * while looking finished.
 *
 * So the empty state is captured deliberately alongside the populated one. Those
 * two images are one boolean apart and mean opposite things, and "nothing to do"
 * is exactly what a broken query looks like.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class PostSaleScreenshotTest {

    private val aug = 1_756_000_000_000L

    private val toShip = listOf(
        sale("s1", buyer = "marguerite_a"),
        sale("s2", buyer = "t_lindqvist"),
    )

    private val toThank = listOf(sale("s3", buyer = "hana_okafor", shippedAt = aug))

    @Test
    fun work_light() = capture("screen-postsale-light") {
        PostSaleContent(PostSaleUiState(toShip = toShip, toThank = toThank), PostSaleActions())
    }

    @Test
    fun work_dark() = capture("screen-postsale-dark", dark = true) {
        PostSaleContent(PostSaleUiState(toShip = toShip, toThank = toThank), PostSaleActions())
    }

    /**
     * Genuinely nothing owed. Kept beside the populated capture on purpose: a
     * query that silently returns nothing renders exactly like a seller who is
     * up to date, and only the two images side by side make that distinguishable.
     */
    @Test
    fun nothingOwed_light() = capture("screen-postsale-empty-light") {
        PostSaleContent(PostSaleUiState(), PostSaleActions())
    }

    /** A failure the seller has to see, because the work is still owed. */
    @Test
    fun error_dark() = capture("screen-postsale-error-dark", dark = true) {
        PostSaleContent(
            PostSaleUiState(
                status = PostSaleViewModel.State(
                    errorMessage = "Could not reach the marketplace.",
                ),
                toShip = toShip,
                toThank = toThank,
            ),
            PostSaleActions(),
        )
    }

    private fun sale(id: String, buyer: String, shippedAt: Long? = null) = SaleEntity(
        id = id,
        inventoryItemId = "i-$id",
        listingId = null,
        salePrice = 40.0,
        platformFees = 5.0,
        paymentProcessingFees = null,
        shippingCollected = null,
        shippingCost = null,
        gradingCost = null,
        otherCosts = null,
        tax = null,
        netProfit = null,
        status = "completed",
        buyerUsername = buyer,
        platformOrderId = "order-$id",
        payoutReference = null,
        saleDate = aug,
        soldAt = aug,
        shippedAt = shippedAt,
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
