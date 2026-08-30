package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.radar.MyStore
import com.gradethread.app.radar.MyStores
import com.gradethread.app.radar.MyStoresActions
import com.gradethread.app.radar.MyStoresContent
import com.gradethread.app.radar.MyStoresViewModel
import com.gradethread.app.radar.StoreSort
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: a golden over which sourcing stores actually pay.
 *
 * ⚠ THIS SCREEN TELLS A SELLER WHERE TO SPEND THEIR SATURDAY. The rows are
 * ranked by what each store has returned, so a sort that silently stops applying
 * does not look broken - it looks like a different answer, and they drive to the
 * wrong shop.
 *
 * ⚠ SO THE FIXTURE RANKS DIFFERENTLY UNDER EACH SORT, deliberately. The
 * Salvation Army store has the highest realized PROFIT; the estate sale has the
 * best ROI on a much smaller spend. If the sort stopped applying, or applied the
 * wrong key, the two captures would be identical - and with a fixture where one
 * store won on every measure, they would be identical anyway and prove nothing.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class MyStoresScreenshotTest {

    private val stores = MyStores(
        stores = listOf(
            // Most total profit, on the most spend.
            store("s1", "Salvation Army - Northgate", spend = 42_000, profit = 96_000, roi = 128.6, sold = 31),
            // Best ROI, far less spend. Wins a different sort.
            store("s2", "Estate sale - Maple Ave", spend = 4_500, profit = 21_000, roi = 366.7, sold = 6),
            store("s3", "Goodwill - Riverside", spend = 18_000, profit = 12_500, roi = 69.4, sold = 14),
        ),
    )

    @Test
    fun byProfit_light() = capture("screen-mystores-profit-light") {
        MyStoresContent(
            MyStoresViewModel.State(stores = stores, sort = StoreSort.PROFIT),
            MyStoresActions(),
        )
    }

    @Test
    fun byProfit_dark() = capture("screen-mystores-profit-dark", dark = true) {
        MyStoresContent(
            MyStoresViewModel.State(stores = stores, sort = StoreSort.PROFIT),
            MyStoresActions(),
        )
    }

    /** A different winner. If this looks like the capture above, sorting broke. */
    @Test
    fun byRoi_light() = capture("screen-mystores-roi-light") {
        MyStoresContent(
            MyStoresViewModel.State(stores = stores, sort = StoreSort.ROI),
            MyStoresActions(),
        )
    }

    /** Nothing sourced yet - a new seller, not a broken query. */
    @Test
    fun empty_light() = capture("screen-mystores-empty-light") {
        MyStoresContent(MyStoresViewModel.State(stores = MyStores()), MyStoresActions())
    }

    /** The failure, with the retry that load() doubles as. */
    @Test
    fun error_dark() = capture("screen-mystores-error-dark", dark = true) {
        MyStoresContent(
            MyStoresViewModel.State(errorMessage = "Could not reach the server."),
            MyStoresActions(),
        )
    }

    @Suppress("LongParameterList")
    private fun store(key: String, name: String, spend: Long, profit: Long, roi: Double, sold: Int) = MyStore(
        key = key,
        name = name,
        sourceType = "thrift",
        location = "Seattle, WA",
        linked = true,
        itemsSourced = sold + 4,
        itemsSold = sold,
        spendCents = spend,
        soldSpendCents = spend,
        realizedProfitCents = profit,
        expectedProfitCents = profit,
        roiPct = roi,
        realizedRoiPct = roi,
    )

    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}
