package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.referrals.NextMilestone
import com.gradethread.app.referrals.ReferralCredits
import com.gradethread.app.referrals.ReferralMe
import com.gradethread.app.referrals.ReferralMilestones
import com.gradethread.app.referrals.ReferralStats
import com.gradethread.app.referrals.ReferralsActions
import com.gradethread.app.referrals.ReferralsContent
import com.gradethread.app.referrals.ReferralsViewModel
import com.gradethread.app.referrals.ReferredBy
import com.gradethread.app.R
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over the code a seller hands to a friend.
 *
 * ⚠ A CODE CAN ONLY BE REDEEMED ONCE, AND THAT IS THREE SCREENS. `redeemed`
 * means it just worked; `alreadyReferred` means somebody else's code is already
 * on this account; and a plain empty field means neither has happened. All
 * three render the same section with different words, and offering the field to
 * someone who already used a code is a form that can only fail.
 *
 * ⚠ THE STATS ARE FOUR NUMBERS THAT MEAN DIFFERENT THINGS. total, pending,
 * qualified and granted are four counts of the same people at different stages,
 * and a tile showing the wrong one tells a seller they have been paid for
 * referrals that have not qualified yet. The fixture gives each a distinct
 * value.
 *
 * ⚠ AND THE SHARE CARD IS THE PRODUCT. The link and the code are the thing
 * being handed over; a card rendering an empty or wrong code hands out a link
 * that credits nobody.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class ReferralsScreenshotTest {

    private val me = ReferralMe(
        code = "THREADBONE",
        // Four different numbers: a tile bound to the wrong one would be
        // invisible if any two matched.
        stats = ReferralStats(total = 9, pending = 3, qualified = 2, granted = 4),
        credits = ReferralCredits(perReferral = 5, earned = 20),
        milestones = ReferralMilestones(
            earnedBonusCredits = 25,
            next = NextMilestone(threshold = 15, bonus = 50),
        ),
    )

    private val loaded = ReferralsViewModel.State(me = me)

    @Test
    fun referrals_light() = capture("screen-referrals-light") {
        ReferralsContent(loaded, ReferralsActions())
    }

    @Test
    fun referrals_dark() = capture("screen-referrals-dark", dark = true) {
        ReferralsContent(loaded, ReferralsActions())
    }

    /** Nobody referred yet. Every count is zero and it must not read as broken. */
    @Test
    fun noReferralsYet_light() = capture("screen-referrals-none-light") {
        ReferralsContent(
            ReferralsViewModel.State(me = ReferralMe(code = "THREADBONE")),
            ReferralsActions(),
        )
    }

    /** Still fetching. */
    @Test
    fun loading_light() = capture("screen-referrals-loading-light") {
        ReferralsContent(ReferralsViewModel.State(loading = true), ReferralsActions())
    }

    /** The load failed, so there is no code to hand out. */
    @Test
    fun loadFailed_dark() = capture("screen-referrals-error-dark", dark = true) {
        ReferralsContent(
            ReferralsViewModel.State(loadError = "Could not reach the server."),
            ReferralsActions(),
        )
    }

    /** A code typed in, ready to apply. */
    @Test
    fun codeTyped_light() = capture("screen-referrals-typed-light") {
        ReferralsContent(loaded.copy(typedCode = "MAPLEAVE"), ReferralsActions())
    }

    /** It worked. One of the three redeem states. */
    @Test
    fun redeemed_light() = capture("screen-referrals-redeemed-light") {
        ReferralsContent(loaded.copy(redeemed = true), ReferralsActions())
    }

    /**
     * Somebody else's code is already on this account. Offering the field here
     * would be a form that can only fail.
     */
    @Test
    fun alreadyReferred_light() = capture("screen-referrals-already-light") {
        ReferralsContent(
            loaded.copy(me = me.copy(referredBy = ReferredBy(status = "qualified"))),
            ReferralsActions(),
        )
    }

    /** The redeem failed. The code stays typed so it can be corrected. */
    @Test
    fun redeemFailed_dark() = capture("screen-referrals-redeem-error-dark", dark = true) {
        ReferralsContent(
            loaded.copy(
                typedCode = "MAPLEAVE",
                // The edge's own refusal, which is what a seller usually sees.
                redeemError = UiMessage(
                    R.string.referral_redeem_failed,
                    "That code is not valid.",
                ),
            ),
            ReferralsActions(),
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
