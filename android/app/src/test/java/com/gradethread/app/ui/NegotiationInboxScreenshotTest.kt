package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.marketplaces.negotiation.BestOffer
import com.gradethread.app.marketplaces.negotiation.BuyerMessage
import com.gradethread.app.marketplaces.negotiation.NegotiationCapability
import com.gradethread.app.marketplaces.negotiation.NegotiationInboxActions
import com.gradethread.app.marketplaces.negotiation.NegotiationInboxContent
import com.gradethread.app.marketplaces.negotiation.NegotiationInboxViewModel
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over offers and buyer messages.
 *
 * ⚠ A FILTERED INBOX LOOKS EXACTLY LIKE AN EMPTY ONE. A deep link scopes this
 * screen to one listing, and without the banner saying so a seller reads "no
 * offers" as "nobody wants my stock" - a conclusion they act on by cutting
 * prices. The banner and its Show all are pure layout, so only a capture can
 * check they are there.
 *
 * ⚠ AND `sendOfferBlocked` SHOWS THE SERVER'S OWN WORDS. The sell.negotiation
 * scope is not licensed on the production keyset, so those endpoints answer
 * 501. The screen probes first and, when blocked, prints the server's detail
 * rather than inventing "reconnect" - because reconnecting cannot help. That
 * distinction is one string, and it is captured.
 *
 * ⚠ THE TWO TABS ARE TWO DIFFERENT FAILURE SURFACES. `offersPhase` and
 * `messagesPhase` fail independently, so one tab can be broken while the other
 * works. Captured that way rather than with both green.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class NegotiationInboxScreenshotTest {

    private val offer = BestOffer(
        bestOfferId = "o1",
        itemId = "125544332211",
        itemTitle = "Patagonia Better Sweater, men's medium",
        buyerUsername = "buyer_mk",
        price = 62.00,
        quantity = 1,
        status = "PENDING",
        message = "Would you take 62 shipped?",
        expiresAt = "2026-09-01T12:00:00Z",
    )

    private val lowball = BestOffer(
        bestOfferId = "o2",
        itemId = "125544332212",
        itemTitle = "Barbour Bedale Wax Jacket",
        buyerUsername = "buyer_rr",
        price = 45.00,
        quantity = 1,
        status = "PENDING",
        message = "45 and I'll collect today.",
    )

    private val message = BuyerMessage(
        messageId = "m1",
        itemId = "125544332211",
        senderUsername = "buyer_mk",
        subject = "Measurements?",
        body = "What's the pit to pit on this one?",
        creationDate = "2026-08-28T09:14:00Z",
        answered = false,
    )

    private val answered = message.copy(
        messageId = "m2",
        senderUsername = "buyer_tt",
        subject = "Shipping",
        body = "Do you post to Canada?",
        answered = true,
    )

    private val loaded = NegotiationInboxViewModel.State(
        offersPhase = NegotiationInboxViewModel.Phase.Ready,
        messagesPhase = NegotiationInboxViewModel.Phase.Ready,
        offers = listOf(offer, lowball),
        messages = listOf(message, answered),
    )

    @Test
    fun offers_light() = capture("screen-negotiation-offers-light") {
        NegotiationInboxContent(loaded, NegotiationInboxActions())
    }

    @Test
    fun offers_dark() = capture("screen-negotiation-offers-dark", dark = true) {
        NegotiationInboxContent(loaded, NegotiationInboxActions())
    }

    /** The messages tab, with one answered and one not. */
    @Test
    fun messages_light() = capture("screen-negotiation-messages-light") {
        NegotiationInboxContent(loaded, NegotiationInboxActions(), tab = 1)
    }

    /**
     * Scoped to one listing by a deep link. The banner is the only thing
     * standing between this and "nobody has offered on anything".
     */
    @Test
    fun filteredToOneListing_light() = capture("screen-negotiation-filtered-light") {
        NegotiationInboxContent(
            loaded.copy(filterItemId = "125544332211"),
            NegotiationInboxActions(),
        )
    }

    /** Filtered AND empty: the case the banner exists for. */
    @Test
    fun filteredAndEmpty_light() = capture("screen-negotiation-filtered-empty-light") {
        NegotiationInboxContent(
            loaded.copy(filterItemId = "999", offers = emptyList()),
            NegotiationInboxActions(),
        )
    }

    /**
     * Send-offer blocked by the keyset, with the server's own explanation. It
     * must NOT say reconnect, because reconnecting changes nothing here.
     */
    @Test
    fun sendOfferBlocked_light() = capture("screen-negotiation-blocked-light") {
        NegotiationInboxContent(
            loaded.copy(
                capability = NegotiationCapability(
                    sendOfferAvailable = false,
                    code = "feature_unavailable",
                    detail = "eBay has not licensed offers to interested buyers on this account.",
                ),
            ),
            NegotiationInboxActions(),
        )
    }

    /** One tab broken and the other fine. They fail independently. */
    @Test
    fun offersFailedMessagesFine_dark() = capture("screen-negotiation-offers-failed-dark", dark = true) {
        NegotiationInboxContent(
            loaded.copy(
                offersPhase = NegotiationInboxViewModel.Phase.Failed("Could not reach eBay."),
                offers = emptyList(),
            ),
            NegotiationInboxActions(),
        )
    }

    /** Both tabs still loading. */
    @Test
    fun loading_light() = capture("screen-negotiation-loading-light") {
        NegotiationInboxContent(
            NegotiationInboxViewModel.State(),
            NegotiationInboxActions(),
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
