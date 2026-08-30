package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.money.AgingBracket
import com.gradethread.app.money.CashFlowMonth
import com.gradethread.app.money.EquityAggregate
import com.gradethread.app.money.EquityPoint
import com.gradethread.app.money.EquitySummary
import com.gradethread.app.money.EquityTrend
import com.gradethread.app.money.ItemProfitRow
import com.gradethread.app.money.ItemProfitSort
import com.gradethread.app.money.MoneyActions
import com.gradethread.app.money.MoneyContent
import com.gradethread.app.money.MoneyMetrics
import com.gradethread.app.R
import com.gradethread.app.money.MoneyUiState
import com.gradethread.app.money.UiMessage
import com.gradethread.app.money.ReceiptScanTrigger
import com.gradethread.app.money.MoneyViewModel
import com.gradethread.app.money.SourceRoiRow
import com.gradethread.app.money.TimeOnMarketBucket
import com.gradethread.app.money.TimeOnMarketStats
import com.gradethread.app.sync.db.ExpenseEntity
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: the money screen, which is the densest surface in the app and
 * the one a seller reads to decide whether any of this is working.
 *
 * ⚠ EVERY TIMESTAMP HERE IS A FIXED CONSTANT, and that is not tidiness. This
 * screen formats dates and derives month labels, so a fixture built from
 * System.currentTimeMillis() produces a golden that goes red the moment the
 * month rolls over. The values below are epoch millis for fixed days in 2026.
 *
 * WHAT THE GOLDENS GUARD. The populated capture is the one that matters: six
 * panels stacked in one scroll, each with its own empty branch, and a
 * regression in any of them is a layout change rather than a logic error. The
 * empty capture is the second half of that - hasAnyData false replaces the
 * whole list with one message, and it is what a new seller sees on day one.
 *
 * The banner captures exist because refreshError and notice are the only two
 * things on this screen that appear ABOVE the content and push it down. A
 * regression that renders both when only one is set is invisible in any test
 * that asserts on text.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class MoneyScreenshotTest {

    // 2026-06-01, 2026-07-01, 2026-08-01 UTC. Fixed, for the reason in the
    // class comment above.
    private val jun = 1_780_272_000_000L
    private val jul = 1_782_950_400_000L
    private val aug = 1_785_628_800_000L

    private val state = MoneyViewModel.State(
        metrics = MoneyMetrics(
            revenueThisMonth = 1_284.50,
            netProfitThisMonth = 486.20,
            roiThisMonth = 0.61,
            monthlyRevenue = emptyList(),
        ),
        cashFlow = listOf(
            CashFlowMonth("jun", jun, "Jun", revenue = 940.00, expenses = 62.00, costBasis = 310.00),
            CashFlowMonth("jul", jul, "Jul", revenue = 1_105.25, expenses = 48.00, costBasis = 402.50),
            CashFlowMonth("aug", aug, "Aug", revenue = 1_284.50, expenses = 71.30, costBasis = 448.00),
        ),
        aging = listOf(
            AgingBracket("0-30 days", 12, 640.00),
            AgingBracket("31-60 days", 5, 275.00),
            AgingBracket("60+ days", 2, 88.00),
        ),
        timeOnMarket = TimeOnMarketStats(
            averageDays = 24.5,
            soldCount = 19,
            distribution = listOf(
                TimeOnMarketBucket("0-7", 4),
                TimeOnMarketBucket("8-30", 11),
                TimeOnMarketBucket("31+", 4),
            ),
        ),
        sourceRoi = listOf(
            SourceRoiRow(
                sourceId = "src_1",
                sourceName = "Goodwill Ankeny",
                acquiredCount = 22,
                soldCount = 14,
                spend = 148.00,
                revenue = 812.00,
                fees = 106.40,
                cogs = 94.00,
            ),
            SourceRoiRow(
                sourceId = null,
                sourceName = "Unattributed",
                acquiredCount = 6,
                soldCount = 5,
                spend = 0.00,
                revenue = 260.00,
                fees = 34.10,
                cogs = 0.00,
            ),
        ),
        profitRows = listOf(
            ItemProfitRow(
                saleId = "sale_1",
                itemId = "item_1",
                title = "Levi's 501 Straight Jean",
                saleDateMs = aug,
                revenue = 62.00,
                fees = 8.06,
                costBasis = 6.00,
                netProfit = 47.94,
            ),
            ItemProfitRow(
                saleId = "sale_2",
                itemId = "item_2",
                title = "Patagonia Synchilla Snap-T",
                saleDateMs = jul,
                revenue = 88.00,
                fees = 11.44,
                costBasis = 12.00,
                netProfit = 64.56,
            ),
        ),
        expenses = listOf(
            ExpenseEntity(
                id = "exp_1",
                category = "Shipping supplies",
                expenseDescription = "Poly mailers, 100ct",
                amount = 24.99,
                spentOn = aug,
                inventoryItemId = null,
                listingId = null,
                createdAt = aug,
            ),
        ),
        expensesThisMonth = 71.30,
        hasAnyData = true,
    )

    private val equity = EquitySummary(
        currency = "USD",
        personalSellThroughDays = 26.0,
        aggregate = EquityAggregate(
            totalEquityCents = 184_250,
            totalLowCents = 152_000,
            totalHighCents = 219_500,
            valuedCount = 17,
            unvaluedCount = 3,
        ),
    )

    private val trend = EquityTrend(
        currency = "USD",
        points = listOf(
            EquityPoint("2026-06-01", 142_000, 118_000, 170_000, 14, 5),
            EquityPoint("2026-07-01", 163_400, 134_000, 194_000, 16, 4),
            EquityPoint("2026-08-01", 184_250, 152_000, 219_500, 17, 3),
        ),
    )

    private fun ui(
        state: MoneyViewModel.State = this.state,
        refreshError: UiMessage? = null,
        notice: UiMessage? = null,
        equity: EquitySummary? = this.equity,
        equityTrend: EquityTrend? = this.trend,
        equityLoading: Boolean = false,
        equityError: String? = null,
    ) = MoneyUiState(
        state = state,
        sort = ItemProfitSort.entries.first(),
        refreshing = false,
        refreshError = refreshError,
        notice = notice,
        equity = equity,
        equityTrend = equityTrend,
        equityLoading = equityLoading,
        equityError = equityError,
    )

    @Test
    fun populated_light() = capture("screen-money-populated-light") { Content(ui()) }

    @Test
    fun populated_dark() = capture("screen-money-populated-dark", dark = true) { Content(ui()) }

    /**
     * US-2979: a five-figure month, which is the size the KPI row broke worse at.
     *
     * The original defect wrapped $1,284.50 into "$1,284.5" and "0" because three
     * equal-width tiles share the row and the first carries both the longest
     * label and the longest value. populated_light covers the four-figure case
     * that found it; this covers the one nothing covered, and it is the case that
     * would hit the shrink-to-fit floor first if the floor were ever raised.
     */
    @Test
    fun fiveFigureMonth_light() = capture("screen-money-bigmonth-light") {
        Content(
            ui(
                state = state.copy(
                    metrics = MoneyMetrics(
                        revenueThisMonth = 18_642.75,
                        netProfitThisMonth = 7_215.40,
                        roiThisMonth = 1.24,
                        monthlyRevenue = emptyList(),
                    ),
                ),
            ),
        )
    }

    /** Day one. hasAnyData false replaces the whole list with one message. */
    @Test
    fun empty_light() = capture("screen-money-empty-light") {
        Content(ui(state = MoneyViewModel.State(), equity = null, equityTrend = null))
    }

    /** Both banners at once, which is the case that stacks. */
    @Test
    fun banners_light() = capture("screen-money-banners-light") {
        Content(
            ui(
                // ⚠ THE SERVER SENTENCE, carried as UiMessage.detail. A banner
                // shows detail when there is one and the resource otherwise,
                // because only our own copy can be translated - and throwing
                // the server text away would drop the only line that says what
                // actually happened.
                refreshError = UiMessage(
                    R.string.money_refresh_failed,
                    "We couldn't reach the server. Showing what's on this device.",
                ),
                notice = UiMessage(R.string.money_expense_saved, "Synced 14 sales."),
            ),
        )
    }

    /**
     * ⚠ THE THIN FIXTURE IS THE POINT, not laziness.
     *
     * InventoryEquityCard sits after five panels, so on a Pixel 5 viewport it is
     * below the fold and a capture of the full dataset shows none of it. The
     * first version of these two cases came out BYTE-IDENTICAL to
     * populated_light - a golden whose name claimed coverage it did not have,
     * which is worse than no golden at all.
     *
     * Emptying the panels above is a real state (a seller with sales but no
     * cash-flow history yet) and it lifts equity into the viewport without
     * capturing a 6000px-tall PNG.
     */
    private val equityFocus = state.copy(
        cashFlow = emptyList(),
        aging = emptyList(),
        timeOnMarket = TimeOnMarketStats.EMPTY,
        sourceRoi = emptyList(),
    )

    @Test
    fun equityLoaded_light() = capture("screen-money-equity-light") {
        Content(ui(state = equityFocus))
    }

    /** Equity is server-computed, so it fails on its own without taking the page. */
    @Test
    fun equityUnavailable_light() = capture("screen-money-equity-error-light") {
        Content(
            ui(
                state = equityFocus,
                equity = null,
                equityTrend = null,
                equityError = "Equity is unavailable right now.",
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
 * Top level for the same reason the other screenshot files' helpers are: an
 * instance composable on a test class trips ComposeUnstableReceiver.
 *
 * ⚠ THE RECEIPT SCANNER COMES IN AS A SLOT, and that is not a convenience.
 * ReceiptScanButton resolves its own ViewModel through Hilt, and RoborazziActivity
 * is not a Hilt component - so composing it here dies with "does not implement
 * GeneratedComponentManager". It went unnoticed when it landed because LazyColumn
 * only composes what is on screen: every capture stayed green except the two
 * equity ones, which empty the panels above and so reach the expenses row.
 *
 * ReceiptScanTrigger is the button's own visible half, so the golden shows the
 * real widget rather than a look-alike written here that could drift from it.
 */
@Composable
private fun Content(ui: MoneyUiState) {
    MoneyContent(
        ui = ui,
        actions = MoneyActions(),
        onOpenSales = {},
        onOpenPayouts = {},
        receiptScan = {
            ReceiptScanTrigger(label = "Scan a receipt", scanning = false, onClick = {})
        },
    )
}
