package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.fulfillment.FulfillmentActions
import com.gradethread.app.fulfillment.FulfillmentContent
import com.gradethread.app.fulfillment.FulfillmentOrder
import com.gradethread.app.fulfillment.FulfillmentUiState
import com.gradethread.app.fulfillment.FulfillmentViewModel
import com.gradethread.app.sync.db.SaleEntity
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over the packing queue.
 *
 * ⚠ THE TRACKING FIELD IS PER ORDER. One field shared across the rows would put
 * the wrong number on the wrong parcel, and nobody finds out until a buyer is
 * watching a stranger's package cross the country. The fixture types a number
 * into the SECOND row and leaves the first empty, so a field that started
 * sharing shows up as two rows carrying the same text.
 *
 * ⚠ AND THE WAIT IS COUNTED FROM ONE STAMP. `nowMs` is fixed in the fixture,
 * with three orders sold at different times, so the golden records three
 * different waits against a single instant. A row that read the clock itself
 * would drift, and every re-record would differ from the last.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class FulfillmentScreenshotTest {

    private val now = 1_756_000_000_000L
    private val day = 24L * 60 * 60 * 1000

    /** Sold this morning. Nothing is late about it. */
    private val fresh = order("o1", "Levi's 501 Straight Jean", soldAt = now - day)

    /** Sold nine days ago and still not posted. This is the one that matters. */
    private val overdue = order("o2", "Barbour Bedale Wax Jacket", soldAt = now - 9 * day)

    private val alsoWaiting = order("o3", "Uniqlo Oxford Shirt", soldAt = now - 3 * day)

    private val queued = FulfillmentViewModel.State(
        queue = listOf(overdue, alsoWaiting, fresh),
        nowMs = now,
    )

    /** Typed into ONE row. If both rows show it, the field started sharing. */
    private val typedIntoOneRow = mapOf(alsoWaiting.id to "9400111899223197428490")

    @Test
    fun queue_light() = capture("screen-fulfillment-light") {
        FulfillmentContent(
            FulfillmentUiState(queued, typedIntoOneRow),
            FulfillmentActions(),
        )
    }

    @Test
    fun queue_dark() = capture("screen-fulfillment-dark", dark = true) {
        FulfillmentContent(
            FulfillmentUiState(queued, typedIntoOneRow),
            FulfillmentActions(),
        )
    }

    /** Nothing left to pack. The good day, and it must look like one. */
    @Test
    fun allCaughtUp_light() = capture("screen-fulfillment-empty-light") {
        FulfillmentContent(
            FulfillmentUiState(FulfillmentViewModel.State(nowMs = now)),
            FulfillmentActions(),
        )
    }

    /** One order mid-flight. Its row is busy and must not be pressable twice. */
    @Test
    fun shipping_light() = capture("screen-fulfillment-busy-light") {
        FulfillmentContent(
            FulfillmentUiState(queued.copy(busyId = overdue.id), typedIntoOneRow),
            FulfillmentActions(),
        )
    }

    /** Posted, plus the recently-posted list underneath. */
    @Test
    fun shipped_dark() = capture("screen-fulfillment-shipped-dark", dark = true) {
        FulfillmentContent(
            FulfillmentUiState(
                queued.copy(
                    queue = listOf(fresh),
                    shipped = listOf(
                        order("o4", "Arc'teryx Beta LT", soldAt = now - 5 * day, shippedAt = now - day),
                    ),
                    banner = "Marked 1 order as posted.",
                ),
            ),
            FulfillmentActions(),
        )
    }

    /** The failure, over the top of a real queue. */
    @Test
    fun error_dark() = capture("screen-fulfillment-error-dark", dark = true) {
        FulfillmentContent(
            FulfillmentUiState(queued.copy(errorMessage = "Could not reach eBay.")),
            FulfillmentActions(),
        )
    }

    private fun order(id: String, title: String, soldAt: Long, shippedAt: Long? = null) = FulfillmentOrder(
        sale = SaleEntity(
            id = id,
            inventoryItemId = "i-$id",
            listingId = null,
            salePrice = 128.00,
            platformFees = 18.90,
            paymentProcessingFees = null,
            shippingCollected = 9.95,
            shippingCost = 8.40,
            gradingCost = null,
            otherCosts = null,
            tax = null,
            netProfit = 109.10,
            buyerUsername = "buyer_$id",
            platformOrderId = "ORD-$id",
            payoutReference = null,
            payoutAmount = null,
            saleDate = soldAt,
            soldAt = soldAt,
            shippedAt = shippedAt,
            trackingNumber = shippedAt?.let { "9400111899223197428491" },
            createdAt = soldAt,
        ),
        itemTitle = title,
    )

    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}
