package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.billing.CreditPack
import com.gradethread.app.billing.CreditPackOffer
import com.gradethread.app.billing.PaywallActions
import com.gradethread.app.billing.PaywallContent
import com.gradethread.app.billing.PaywallPricing
import com.gradethread.app.billing.PaywallViewModel
import com.gradethread.app.billing.PlanTier
import com.gradethread.app.billing.PlayPurchaseRules
import com.gradethread.app.billing.SubscriptionInterval
import com.gradethread.app.billing.SubscriptionOffer
import com.gradethread.app.billing.SubscriptionProduct
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over the screen that takes money.
 *
 * ⚠ THE AUTO-RENEWAL DISCLOSURE HAS A POSITION, NOT JUST A PRESENCE. US-2126
 * put it directly under the tiers and above the credit packs, because it has to
 * sit where the subscribing happens rather than at the bottom of a scroll.
 * Nothing but a capture can check where a paragraph ended up.
 *
 * ⚠ A CONFLICT REPLACES THE ERROR RATHER THAN JOINING IT. When Play reports an
 * existing subscription the screen shows a warning carrying the conflict's own
 * words and suppresses the ordinary error card - two red boxes about one
 * problem read as two problems. Both are captured, and the fixture sets BOTH
 * fields on the conflict case so a screen that stopped suppressing would show
 * two cards.
 *
 * ⚠ AND `purchasable` IS DERIVED. A row is buyable only when Play returned an
 * offer token AND it is not the current plan, so the fixture gives one row no
 * token and marks another as current, rather than asserting a flag.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class PaywallScreenshotTest {

    private fun row(
        product: SubscriptionProduct,
        price: String?,
        token: String?,
        savings: Int? = null,
        current: Boolean = false,
    ) = PaywallPricing.TierRow(
        offer = SubscriptionOffer(product = product, formattedPrice = price, offerToken = token),
        savingsPercent = savings,
        current = current,
    )

    private val yearlyRows = listOf(
        row(SubscriptionProduct.STARTER_YEARLY, "$290.00", "tok-starter", savings = 17),
        // The plan they already pay for. Not purchasable, and it must say why.
        row(SubscriptionProduct.PRO_YEARLY, "$590.00", "tok-pro", savings = 17, current = true),
        // Play never returned an offer token, so this one cannot be bought.
        //
        // ⚠ THE PRICE MATCHES ITS REFERENCE CENTS ON PURPOSE. PaywallPricing
        // .monthlyEquivalent derives "about X a month" from
        // product.fallbackPriceCents rather than from Play string, deliberately
        // and for the same reason the savings percentage is. The first version
        // of this fixture priced Business at $1,190 against a $990 reference,
        // and the golden showed two figures that do not divide - a picture of a
        // bug the app does not have, on the screen where that matters most.
        row(SubscriptionProduct.BUSINESS_YEARLY, "$990.00", null, savings = 17),
    )

    private val packs = CreditPack.entries.map { CreditPackOffer(it, formattedPrice = null) }

    private val loaded = PaywallViewModel.State(
        interval = SubscriptionInterval.YEARLY,
        rows = yearlyRows,
        creditPacks = packs,
        currentPlan = PlanTier.PRO,
        loading = false,
    )

    @Test
    fun yearly_light() = capture("screen-paywall-light") {
        PaywallContent(loaded, PaywallActions())
    }

    @Test
    fun yearly_dark() = capture("screen-paywall-dark", dark = true) {
        PaywallContent(loaded, PaywallActions())
    }

    /** Monthly, and nothing bought yet. */
    @Test
    fun monthlyNoPlan_light() = capture("screen-paywall-monthly-light") {
        PaywallContent(
            loaded.copy(
                interval = SubscriptionInterval.MONTHLY,
                currentPlan = null,
                rows = listOf(
                    row(SubscriptionProduct.STARTER_MONTHLY, "$29.00", "tok-starter-m"),
                    row(SubscriptionProduct.PRO_MONTHLY, "$59.00", "tok-pro-m"),
                ),
            ),
            PaywallActions(),
        )
    }

    /**
     * Already billed on the web. The warning carries Stripe's story and the
     * ordinary error is suppressed - the fixture sets both so a screen that
     * stopped suppressing would show two cards about one problem.
     */
    @Test
    fun stripeConflict_light() = capture("screen-paywall-conflict-light") {
        PaywallContent(
            loaded.copy(
                conflict = PlayPurchaseRules.Conflict.ActiveStripeSubscription,
                errorMessage = "Google Play refused the purchase.",
            ),
            PaywallActions(),
        )
    }

    /** The purchase belongs to another account. A different conflict, same shape. */
    @Test
    fun wrongAccountConflict_dark() = capture("screen-paywall-conflict-account-dark", dark = true) {
        PaywallContent(
            loaded.copy(conflict = PlayPurchaseRules.Conflict.PurchaseNotOwned),
            PaywallActions(),
        )
    }

    /** An ordinary failure with no conflict. One card, in the error tone. */
    @Test
    fun error_dark() = capture("screen-paywall-error-dark", dark = true) {
        PaywallContent(
            loaded.copy(errorMessage = "Google Play refused the purchase."),
            PaywallActions(),
        )
    }

    /** A purchase in flight. Nothing may be pressed twice. */
    @Test
    fun purchasing_light() = capture("screen-paywall-purchasing-light") {
        PaywallContent(loaded.copy(purchasing = true), PaywallActions())
    }

    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}
