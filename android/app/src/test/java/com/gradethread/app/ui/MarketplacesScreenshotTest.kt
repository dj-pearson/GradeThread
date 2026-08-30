package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.marketplaces.ExtensionQueueItem
import com.gradethread.app.marketplaces.ExtensionQueueResult
import com.gradethread.app.marketplaces.ListingCardModel
import com.gradethread.app.marketplaces.MarketplaceConnection
import com.gradethread.app.marketplaces.MarketplacesActions
import com.gradethread.app.marketplaces.MarketplacesContent
import com.gradethread.app.marketplaces.MarketplacesUiState
import com.gradethread.app.marketplaces.MarketplacesViewModel
import com.gradethread.app.marketplaces.PendingDelist
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over the eBay account surface.
 *
 * ⚠ AN IMPORTED LISTING GETS NEITHER PROMOTE NOR EDIT, and those buttons are
 * ABSENT rather than greyed. eBay authored those listings and owns their
 * lifecycle, so a disabled Edit would read as one tap from working. The fixture
 * puts an imported listing beside one of ours so the two cards have to differ.
 *
 * ⚠ THE DELIST QUEUE IS A DOUBLE-SALE GUARD, and its button ORDER is the
 * argument. "Queue for my desktop" comes first because it is the one that
 * actually ends the listing; "I ended it myself" second, because it clears the
 * stamp without the extension - and a stamp cleared on a listing that is still
 * live is the double sale itself.
 *
 * ⚠ AND QUEUED WORK SPLITS INTO TWO LISTS THAT LOOK ALIKE. `queuePending` is
 * still coming; `queueNeedsAttention` expired or failed. Showing the second as
 * "still coming" is the silence the queue exists to remove, so both are on
 * screen at once here.
 *
 * ⚠ THE PROMOTION SHEET IS A SLOT. PromotionSheet resolves its own ViewModel
 * through Hilt and RoborazziActivity is not a Hilt component.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class MarketplacesScreenshotTest {

    private val primary = MarketplaceConnection(
        id = "c1",
        marketplace = "ebay",
        accountHandle = "threadandbone",
        label = "Main shop",
        isPrimary = true,
        isActive = true,
        lastSyncedAt = "2026-08-29T22:10:00Z",
    )

    /** Second account, and one that needs reconnecting. Both states at once. */
    private val secondary = MarketplaceConnection(
        id = "c2",
        marketplace = "ebay",
        accountHandle = "bone_outlet",
        isPrimary = false,
        isActive = true,
        refreshError = "eBay refused the refresh token. Reconnect this account.",
    )

    /** Published by GradeThread. Gets Promote and Edit. */
    private val ours = ListingCardModel(
        id = "l1",
        platform = "ebay",
        platformLabel = "eBay",
        priceText = "$128.00",
        quantity = 1,
        status = "active",
        externalUrl = "https://example.invalid/1",
        publishError = null,
        isImported = false,
    )

    /** Authored on eBay. Gets neither, and that must be visible. */
    private val imported = ListingCardModel(
        id = "l2",
        platform = "ebay",
        platformLabel = "eBay",
        priceText = "$210.00",
        quantity = 1,
        status = "active",
        externalUrl = "https://example.invalid/2",
        publishError = null,
        isImported = true,
    )

    private val loaded = MarketplacesViewModel.State(
        connections = listOf(primary, secondary),
        loading = false,
    )

    private val ui = MarketplacesUiState(loaded, listOf(ours, imported))

    @Test
    fun connected_light() = capture("screen-marketplaces-light") {
        MarketplacesContent(ui, MarketplacesActions(), promotionSheet = { PromotionStandIn() })
    }

    @Test
    fun connected_dark() = capture("screen-marketplaces-dark", dark = true) {
        MarketplacesContent(ui, MarketplacesActions(), promotionSheet = { PromotionStandIn() })
    }

    /** No account yet. The first thing a new seller sees. */
    @Test
    fun notConnected_light() = capture("screen-marketplaces-empty-light") {
        MarketplacesContent(
            MarketplacesUiState(MarketplacesViewModel.State(loading = false)),
            MarketplacesActions(),
            promotionSheet = { PromotionStandIn() },
        )
    }

    /**
     * Sold elsewhere, still live here. Both buttons in the order that matters,
     * and one row eBay can end automatically beside one it cannot.
     */
    @Test
    fun pendingDelists_light() = capture("screen-marketplaces-delists-light") {
        MarketplacesContent(
            MarketplacesUiState(
                // ⚠ NO eBAY CONNECTION, DELIBERATELY. The six navigation
                // buttons are gated on canSync, and with them on screen this
                // section sits below the fold - the first recording of this
                // golden showed the heading and none of the rows, while its
                // own comment claimed to prove the button order. A seller with
                // no eBay account CAN have pending delists: these are Poshmark
                // and Depop listings, which the extension owns.
                MarketplacesViewModel.State(
                    loading = false,
                    pendingDelists = listOf(
                        PendingDelist(
                            listingId = "p1",
                            platform = "poshmark",
                            listingUrl = "https://example.invalid/posh/1",
                            listingStatus = "active",
                            autoDelistable = true,
                            itemId = "i1",
                            itemTitle = "Patagonia Better Sweater",
                            requestedAt = "2026-08-29T18:00:00Z",
                        ),
                        // Never confirmed live. Needs different words from
                        // "no saved URL", or the seller hunts for nothing.
                        PendingDelist(
                            listingId = "p2",
                            platform = "depop",
                            listingStatus = "draft",
                            autoDelistable = false,
                            itemId = "i2",
                            itemTitle = "Barbour Bedale Wax Jacket",
                        ),
                    ),
                ),
            ),
            MarketplacesActions(),
            promotionSheet = { PromotionStandIn() },
        )
    }

    /** Queued work that is coming, beside queued work that is not. */
    @Test
    fun queueSplit_dark() = capture("screen-marketplaces-queue-dark", dark = true) {
        MarketplacesContent(
            ui.copy(
                state = loaded.copy(
                    queuePending = listOf(
                        ExtensionQueueItem(
                            id = "q1",
                            kind = "delist",
                            platform = "poshmark",
                            status = "pending",
                            createdAt = "2026-08-29T18:00:00Z",
                            expiresAt = "2026-09-05T18:00:00Z",
                        ),
                    ),
                    queueNeedsAttention = listOf(
                        ExtensionQueueItem(
                            id = "q2",
                            kind = "delist",
                            platform = "depop",
                            status = "expired",
                            createdAt = "2026-08-14T09:00:00Z",
                            result = ExtensionQueueResult(expired = true),
                        ),
                    ),
                ),
            ),
            MarketplacesActions(),
            promotionSheet = { PromotionStandIn() },
        )
    }

    /** Mid-connect: the button says so and cannot be pressed twice. */
    @Test
    fun connecting_light() = capture("screen-marketplaces-connecting-light") {
        MarketplacesContent(
            MarketplacesUiState(MarketplacesViewModel.State(loading = false, connecting = true)),
            MarketplacesActions(),
            promotionSheet = { PromotionStandIn() },
        )
    }

    /** The disconnect confirmation. */
    @Test
    fun disconnectDialog_dark() = capture("screen-marketplaces-disconnect-dark", dark = true) {
        MarketplacesContent(
            ui,
            MarketplacesActions(),
            disconnecting = primary,
            promotionSheet = { PromotionStandIn() },
        )
    }

    /** The rename dialog. */
    @Test
    fun renameDialog_light() = capture("screen-marketplaces-rename-light") {
        MarketplacesContent(
            ui,
            MarketplacesActions(),
            renaming = primary,
            promotionSheet = { PromotionStandIn() },
        )
    }

    /** The failure. */
    @Test
    fun error_dark() = capture("screen-marketplaces-error-dark", dark = true) {
        MarketplacesContent(
            ui.copy(state = loaded.copy(errorMessage = "Could not reach eBay.")),
            MarketplacesActions(),
            promotionSheet = { PromotionStandIn() },
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
 * ⚠ TOP LEVEL, NOT A METHOD ON THE TEST CLASS. A composable declared as an
 * instance function has the class as its receiver, and Android lint's
 * ComposeUnstableReceiver fails the build for it: an unstable receiver means
 * the function recomposes every time. The other screenshot files already put
 * their helpers here for the same reason.
 */
@Composable
private fun PromotionStandIn() {
    Text("Promotion sheet")
}
