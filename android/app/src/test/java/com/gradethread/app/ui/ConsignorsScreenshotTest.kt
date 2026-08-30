package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.consignment.Consignor
import com.gradethread.app.consignment.ConsignorDraft
import com.gradethread.app.consignment.ConsignorsActions
import com.gradethread.app.consignment.ConsignorsContent
import com.gradethread.app.consignment.ConsignorsViewModel
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over the people whose money this splits.
 *
 * ⚠ THE SPLIT IS SOMEBODY ELSE'S SHARE. Every row carries the percentage that
 * decides what a consignor is owed on each sale, so a card rendering the wrong
 * number - or rendering it where the name goes - is a payout dispute rather
 * than a cosmetic bug. The fixture gives three consignors three different
 * splits so no two rows can be confused for each other.
 *
 * ⚠ AND THE DELETE DIALOG SAYS WHAT DOES NOT HAPPEN. Sellers hesitate because
 * removing a consignor looks like it might take their sales history with it.
 * That sentence lives only in the dialog.
 *
 * ⚠ THE EMPTY CARD IS GATED ON `loaded`, not on the list being empty - the list
 * is empty for the whole first frame of every visit. Both states are captured.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class ConsignorsScreenshotTest {

    private val consignors = listOf(
        Consignor(
            id = "c1",
            name = "Marta Ruiz",
            contactEmail = "marta@example.invalid",
            contactPhone = "+1 206 555 0142",
            defaultSplitPct = 60.0,
            notes = "Brings vintage denim every other Saturday.",
        ),
        Consignor(
            id = "c2",
            name = "Northgate Church Sale",
            contactEmail = null,
            contactPhone = null,
            defaultSplitPct = 40.0,
        ),
        // A whole-number split beside two others. Three different numbers so no
        // two rows can be mistaken for each other.
        Consignor(
            id = "c3",
            name = "Tom Whitfield",
            contactEmail = "tom@example.invalid",
            defaultSplitPct = 50.0,
        ),
    )

    private val loaded = ConsignorsViewModel.State(consignors = consignors, loaded = true)

    @Test
    fun consignors_light() = capture("screen-consignors-light") {
        ConsignorsContent(loaded, ConsignorsActions())
    }

    @Test
    fun consignors_dark() = capture("screen-consignors-dark", dark = true) {
        ConsignorsContent(loaded, ConsignorsActions())
    }

    /** Loaded, and genuinely none. The only state allowed to say so. */
    @Test
    fun noneYet_light() = capture("screen-consignors-empty-light") {
        ConsignorsContent(ConsignorsViewModel.State(loaded = true), ConsignorsActions())
    }

    /**
     * The first frame of every visit: empty but not LOADED. Must not claim
     * there are no consignors to someone who has three.
     */
    @Test
    fun stillLoading_light() = capture("screen-consignors-loading-light") {
        ConsignorsContent(
            ConsignorsViewModel.State(loading = true, loaded = false),
            ConsignorsActions(),
        )
    }

    /** The editor, open on an existing consignor. */
    @Test
    fun editor_light() = capture("screen-consignors-editor-light") {
        ConsignorsContent(
            loaded.copy(
                editingId = "c1",
                editing = ConsignorDraft(
                    name = "Marta Ruiz",
                    contactEmail = "marta@example.invalid",
                    contactPhone = "+1 206 555 0142",
                    splitText = "60",
                    notes = "Brings vintage denim every other Saturday.",
                ),
            ),
            ConsignorsActions(),
        )
    }

    /**
     * A new consignor with no name. `canSave` is false, so Save must not look
     * pressable - the validation lives in the draft and shows only here.
     */
    @Test
    fun newUnnamed_dark() = capture("screen-consignors-editor-empty-dark", dark = true) {
        ConsignorsContent(loaded.copy(editing = ConsignorDraft()), ConsignorsActions())
    }

    /** The delete dialog, and its promise that the sales history stays. */
    @Test
    fun deleteDialog_dark() = capture("screen-consignors-delete-dark", dark = true) {
        ConsignorsContent(loaded.copy(deleting = consignors.first()), ConsignorsActions())
    }

    /** The failure. */
    @Test
    fun error_dark() = capture("screen-consignors-error-dark", dark = true) {
        ConsignorsContent(
            loaded.copy(errorMessage = "Could not reach the server."),
            ConsignorsActions(),
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
