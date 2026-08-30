package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.capture.FlipdeskCategory
import com.gradethread.app.inventory.AspectConstraint
import com.gradethread.app.inventory.AspectSpecState
import com.gradethread.app.inventory.CompsState
import com.gradethread.app.inventory.EbayAspect
import com.gradethread.app.inventory.ItemCanvasActions
import com.gradethread.app.inventory.ItemCanvasContent
import com.gradethread.app.inventory.ItemCanvasViewModel
import com.gradethread.app.inventory.ItemComp
import com.gradethread.app.inventory.ItemDraft
import com.gradethread.app.inventory.ListingCopy
import com.gradethread.app.inventory.SizeEstimate
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over one item's whole editable record.
 *
 * ⚠ PUBLISH IS DISABLED WHILE THE CANVAS IS DIRTY, and the button has to say
 * why. The server lists what is in the database, so publishing over unsaved
 * edits would put the OLD title and the OLD price on eBay while this screen
 * showed the new ones. Clean and dirty are both captured.
 *
 * ⚠ AND AI COPY IS A PROPOSAL, NOT AN EDIT. Nothing reaches the description
 * until "Use this" is tapped, because the only undo on this screen is retyping.
 * An empty answer is a real answer and says so rather than applying itself.
 *
 * ⚠ THE PHOTO SECTION AND THE CONSIGNOR PICKER ARE ABSENT FROM THESE PIXELS,
 * not broken. Both resolve their own Hilt ViewModel, so the goldens pass empty
 * slots and a regression in either is out of scope for this file.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class ItemCanvasScreenshotTest {

    private val draft = ItemDraft(
        title = "Patagonia Better Sweater, men's medium, oatmeal",
        brand = "Patagonia",
        sku = "PAT-0142",
        size = "M",
        color = "Oatmeal",
        material = "Recycled polyester fleece",
        style = "Quarter-zip",
        category = FlipdeskCategory.CLOTHING,
        garmentType = "Fleece jacket",
        garmentCategory = "Sweaters",
        description = "Worn a handful of times. No pilling on the body.",
        conditionNotes = "Small mark on the left cuff, photographed.",
        sourcedBy = "Rae",
        container = "Bin 4",
        locationBin = "A-12",
        acquiredPriceText = "12.00",
        targetPriceText = "68.00",
        measurements = mapOf("chest" to 21.0, "length" to 27.5),
        comps = listOf(
            ItemComp(price = 64.0, source = "eBay", soldDate = "2026-08-11"),
            ItemComp(price = 72.0, source = "eBay", soldDate = "2026-08-04"),
        ),
    )

    /** Nothing edited yet, so the canvas is clean and publish is live. */
    private val clean = ItemCanvasViewModel.State(
        itemId = "i1",
        loading = false,
        original = draft,
        draft = draft,
    )

    private val aspects = AspectSpecState.Loaded(
        aspects = listOf(
            EbayAspect(
                localizedAspectName = "Brand",
                aspectConstraint = AspectConstraint(aspectRequired = true),
            ),
            EbayAspect(
                localizedAspectName = "Size",
                aspectConstraint = AspectConstraint(aspectRequired = true),
            ),
            EbayAspect(localizedAspectName = "Colour"),
        ),
        categoryName = "Men's Sweaters",
    )

    @Test
    fun clean_light() = capture("screen-canvas-light") {
        ItemCanvasContent(clean, ItemCanvasActions())
    }

    @Test
    fun clean_dark() = capture("screen-canvas-dark", dark = true) {
        ItemCanvasContent(clean, ItemCanvasActions())
    }

    /**
     * An unsaved edit. Publish goes dead and says "Save first" - compare with
     * the clean capture, where it is live.
     */
    @Test
    fun dirty_light() = capture("screen-canvas-dirty-light") {
        ItemCanvasContent(
            clean.copy(draft = draft.copy(targetPriceText = "74.00")),
            ItemCanvasActions(),
        )
    }

    /** A brand-new item. Nothing typed, no category picked. */
    @Test
    fun blank_light() = capture("screen-canvas-blank-light") {
        ItemCanvasContent(
            ItemCanvasViewModel.State(itemId = "i2", loading = false),
            ItemCanvasActions(),
        )
    }

    /** Still fetching the row. */
    @Test
    fun loading_light() = capture("screen-canvas-loading-light") {
        ItemCanvasContent(ItemCanvasViewModel.State(), ItemCanvasActions())
    }

    /** Saving. */
    @Test
    fun saving_light() = capture("screen-canvas-saving-light") {
        ItemCanvasContent(
            clean.copy(draft = draft.copy(color = "Natural"), saving = true),
            ItemCanvasActions(),
        )
    }

    /**
     * The edit is KEPT, waiting for signal. Named as saved-and-waiting rather
     * than as a failure, because it is not one.
     */
    @Test
    fun queuedOffline_light() = capture("screen-canvas-offline-light") {
        ItemCanvasContent(clean.copy(queuedOffline = true), ItemCanvasActions())
    }

    /** The save was refused. */
    @Test
    fun error_dark() = capture("screen-canvas-error-dark", dark = true) {
        ItemCanvasContent(
            clean.copy(errorMessage = "Could not reach the server."),
            ItemCanvasActions(),
        )
    }

    /** The eBay specifics for this category, two of them required. */
    @Test
    fun aspectsLoaded_light() = capture("screen-canvas-aspects-light") {
        ItemCanvasContent(clean.copy(aspectSpec = aspects), ItemCanvasActions())
    }

    /** Comps came back. */
    @Test
    fun compsLoading_light() = capture("screen-canvas-comps-loading-light") {
        ItemCanvasContent(clean.copy(comps = CompsState.Loading), ItemCanvasActions())
    }

    /** No category, so there is nothing to look comps up against. */
    @Test
    fun compsNoCategory_light() = capture("screen-canvas-comps-nocategory-light") {
        ItemCanvasContent(
            clean.copy(
                draft = draft.copy(category = null),
                original = draft.copy(category = null),
                comps = CompsState.NoCategory,
            ),
            ItemCanvasActions(),
        )
    }

    /** The AI's proposed copy, sitting above the fields it would replace. */
    @Test
    fun listingCopyProposed_light() = capture("screen-canvas-copy-light") {
        ItemCanvasContent(
            clean.copy(
                aspectSpec = aspects,
                listingCopy = ListingCopy(
                    title = "Patagonia Better Sweater Quarter-Zip Fleece Men's M Oatmeal",
                    description = "Classic Better Sweater in oatmeal. Worn lightly, " +
                        "no pilling through the body. Chest 21in, length 27.5in.",
                    actionsRemaining = 4,
                ),
            ),
            ItemCanvasActions(),
        )
    }

    /**
     * An empty answer is a real answer. Applying it would erase copy the seller
     * already wrote, so it offers a dismiss and nothing else.
     */
    @Test
    fun listingCopyEmpty_light() = capture("screen-canvas-copy-empty-light") {
        ItemCanvasContent(
            clean.copy(aspectSpec = aspects, listingCopy = ListingCopy()),
            ItemCanvasActions(),
        )
    }

    /** The size the model thinks this is, before anyone accepts it. */
    @Test
    fun sizeEstimate_light() = capture("screen-canvas-size-estimate-light") {
        ItemCanvasContent(
            clean.copy(
                sizeEstimate = SizeEstimate(
                    size = "M",
                    gender = "Men",
                    confidence = 0.82,
                    rationale = "Chest 21in and length 27.5in match Patagonia's men's medium.",
                ),
            ),
            ItemCanvasActions(),
        )
    }

    /** A cross-list handed to the desktop. Waiting, never "listed". */
    @Test
    fun queuedForDesktop_light() = capture("screen-canvas-queued-light") {
        ItemCanvasContent(clean.copy(queuedForDesktop = "poshmark"), ItemCanvasActions())
    }

    /** The item is gone. */
    @Test
    fun notFound_light() = capture("screen-canvas-notfound-light") {
        ItemCanvasContent(
            ItemCanvasViewModel.State(loading = false, notFound = true),
            ItemCanvasActions(),
        )
    }

    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        // A TALL VIEWPORT ON PURPOSE. This form is longer than a phone screen,
        // and the things worth pinning - the save button, the publish button
        // and its "save first" wording - all sit below the fold. A Pixel 5
        // capture would show seven text fields and claim to cover them.
        RuntimeEnvironment.setQualifiers("+h3100dp")
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}
