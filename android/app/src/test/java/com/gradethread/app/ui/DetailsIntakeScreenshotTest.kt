package com.gradethread.app.ui

import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.capture.DetailsIntakeState
import com.gradethread.app.inventory.DetailsIntakeActions
import com.gradethread.app.inventory.DetailsIntakeContent
import com.gradethread.app.inventory.DetailsIntakeViewModel
import com.gradethread.app.inventory.IntakeSubmission
import com.gradethread.app.inventory.ItemMergePlan
import com.gradethread.app.sync.db.SourceEntity
import com.gradethread.app.sync.db.SourcerEntity
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over cataloguing one item.
 *
 * ⚠ THE MERGE PROMPT DECIDES WHOSE DATA SURVIVES. When an intake matches an
 * item already in inventory, this screen asks field by field which copy to
 * keep - and whatever is not kept is gone. A prompt that rendered the wrong
 * side, or dropped a conflict row, silently overwrites something a seller typed
 * weeks ago and tells them nothing.
 *
 * ⚠ AND A CONFLICT IS NOT A GAP. `bothFilled` false means the existing row is
 * blank and the form is filling it in, which needs no decision at all. The
 * fixture carries one of each, because rendering a gap as a choice asks someone
 * to pick between a value and nothing.
 *
 * ⚠ `showValidation` EXISTS SO THE FORM IS NOT RED ON OPEN. Errors appear only
 * after a save attempt. A blank form scolding someone before they have typed
 * anything is the fastest way to make them close it, so both are captured.
 *
 * ⚠ THE NOTES FIELD IS A SLOT. It owns a DictationController built from a
 * Context, which a screenshot test does not have.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class DetailsIntakeScreenshotTest {

    private val aug = 1_756_000_000_000L

    private val sources = listOf(
        SourceEntity(
            id = "s1",
            userId = "u1",
            name = "Goodwill — Capitol Hill",
            sourceType = "thrift",
            notes = null,
            archivedAt = null,
            createdAt = aug,
            updatedAt = aug,
        ),
    )

    private val sourcers = listOf(
        SourcerEntity(
            id = "p1",
            userId = "u1",
            name = "Sam",
            memberUserId = null,
            archivedAt = null,
            createdAt = aug,
            updatedAt = aug,
        ),
    )

    private val filled = DetailsIntakeState(
        title = "Patagonia Better Sweater",
        sku = "PAT-BS-M",
        brand = "Patagonia",
        style = "Fleece jacket",
        size = "M",
        color = "Oatmeal",
        material = "Recycled polyester",
        sourceId = "s1",
        container = "Rail 3",
        sourcedBy = "Sam",
        purchaseDate = "2026-08-24",
        purchasePriceText = "24.00",
        notes = "Light pilling at the cuffs.",
    )

    private val ready = DetailsIntakeViewModel.UiState(
        form = filled,
        sources = sources,
        sourcerRoster = sourcers,
    )

    @Test
    fun filledForm_light() = capture("screen-intake-light") {
        DetailsIntakeContent(ready, DetailsIntakeActions(), notesField = { v, onChange -> NotesStandIn(v, onChange) })
    }

    @Test
    fun filledForm_dark() = capture("screen-intake-dark", dark = true) {
        DetailsIntakeContent(ready, DetailsIntakeActions(), notesField = { v, onChange -> NotesStandIn(v, onChange) })
    }

    /** Blank and untouched. NOT red: nobody has tried to save yet. */
    @Test
    fun blankForm_light() = capture("screen-intake-blank-light") {
        DetailsIntakeContent(
            DetailsIntakeViewModel.UiState(sources = sources, sourcerRoster = sourcers),
            DetailsIntakeActions(),
            notesField = { v, onChange -> NotesStandIn(v, onChange) },
        )
    }

    /** Blank AFTER a save attempt. This is where the errors belong. */
    @Test
    fun blankAfterSave_dark() = capture("screen-intake-invalid-dark", dark = true) {
        DetailsIntakeContent(
            DetailsIntakeViewModel.UiState(
                sources = sources,
                sourcerRoster = sourcers,
                showValidation = true,
            ),
            DetailsIntakeActions(),
            notesField = { v, onChange -> NotesStandIn(v, onChange) },
        )
    }

    /** A recovered draft, waiting to be resumed or thrown away. */
    @Test
    fun pendingDraft_light() = capture("screen-intake-draft-light") {
        DetailsIntakeContent(
            ready.copy(pendingDraft = filled),
            DetailsIntakeActions(),
            notesField = { v, onChange -> NotesStandIn(v, onChange) },
        )
    }

    /**
     * The merge prompt, with a real conflict beside a gap. Only the first is a
     * decision; the second is the form filling in a blank.
     */
    @Test
    fun mergePrompt_light() = capture("screen-intake-merge-light") {
        DetailsIntakeContent(
            ready.copy(
                merge = DetailsIntakeViewModel.MergePrompt(
                    existing = IntakeSubmission.ExistingItem(
                        id = "i1",
                        title = "Patagonia fleece",
                        brand = "Patagonia",
                        size = "L",
                    ),
                    conflicts = listOf(
                        // Both sides filled: a genuine choice.
                        conflict(ItemMergePlan.Field.SIZE, "M", "L", bothFilled = true),
                        // Existing is blank: nothing to decide.
                        conflict(ItemMergePlan.Field.COLOR, "Oatmeal", "", bothFilled = false),
                    ),
                    keepExisting = setOf(ItemMergePlan.Field.SIZE),
                ),
            ),
            DetailsIntakeActions(),
            notesField = { v, onChange -> NotesStandIn(v, onChange) },
        )
    }

    /** Saving. Nothing may be pressed twice. */
    @Test
    fun saving_light() = capture("screen-intake-saving-light") {
        DetailsIntakeContent(
            ready.copy(saving = true),
            DetailsIntakeActions(),
            notesField = { v, onChange -> NotesStandIn(v, onChange) },
        )
    }

    /** A failure banner over a filled form. */
    @Test
    fun error_dark() = capture("screen-intake-error-dark", dark = true) {
        DetailsIntakeContent(
            ready.copy(
                banner = DetailsIntakeViewModel.Banner("Could not save that item.", isError = true),
            ),
            DetailsIntakeActions(),
            notesField = { v, onChange -> NotesStandIn(v, onChange) },
        )
    }

    private fun conflict(field: ItemMergePlan.Field, current: String, existing: String, bothFilled: Boolean) =
        ItemMergePlan.Conflict(
            field = field,
            current = ItemMergePlan.Value(current.lowercase(), current),
            existing = ItemMergePlan.Value(existing.lowercase(), existing),
            bothFilled = bothFilled,
        )

    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}

/**
 * ⚠ TOP LEVEL, NOT A METHOD ON THE TEST CLASS. Android lint's
 * ComposeUnstableReceiver fails on an instance composable.
 *
 * The real field builds a DictationController from a Context. This is the same
 * text box without the microphone.
 */
@Composable
private fun NotesStandIn(value: String, onValueChange: (String) -> Unit) {
    OutlinedTextField(value = value, onValueChange = onValueChange, label = { Text("Notes") })
}
