package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.templates.ListingTemplate
import com.gradethread.app.templates.TemplateDraft
import com.gradethread.app.templates.TemplatesActions
import com.gradethread.app.templates.TemplatesContent
import com.gradethread.app.templates.TemplatesViewModel
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over listing templates.
 *
 * ⚠ THE EMPTY CARD IS GATED ON `loaded`, NOT ON THE LIST BEING EMPTY, and that
 * is the thing worth capturing. The list is empty for the whole first frame of
 * every visit, so keying "no templates yet" on emptiness alone would flash it
 * at every seller who does have templates. Both states are here: empty and
 * loaded, versus empty and still loading.
 *
 * ⚠ AND THE DELETE DIALOG MAKES A CLAIM ABOUT OLD LISTINGS. A template is
 * prefill, not a link - deleting one does not reach back into listings that
 * used it. Sellers hesitate precisely because they assume the opposite, and
 * that sentence lives only in the dialog.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class TemplatesScreenshotTest {

    private val defaultTemplate = ListingTemplate(
        id = "t1",
        name = "Vintage denim",
        descriptionTemplate = "Measured flat. Ships next business day.",
        ebayCondition = "USED_EXCELLENT",
        conditionDescription = "Light fading, no holes or repairs.",
        itemSpecifics = mapOf("Department" to "Men", "Style" to "Straight"),
        ebayCategoryId = "11483",
        isDefault = true,
        sortOrder = 0,
    )

    private val plainTemplate = ListingTemplate(
        id = "t2",
        name = "Outerwear",
        descriptionTemplate = "Wax jackets are sold as-is unless stated.",
        ebayCondition = "USED_GOOD",
        itemSpecifics = mapOf("Department" to "Men"),
        isDefault = false,
        sortOrder = 1,
    )

    private val loaded = TemplatesViewModel.State(
        templates = listOf(defaultTemplate, plainTemplate),
        loaded = true,
    )

    @Test
    fun templates_light() = capture("screen-templates-light") {
        TemplatesContent(loaded, TemplatesActions())
    }

    @Test
    fun templates_dark() = capture("screen-templates-dark", dark = true) {
        TemplatesContent(loaded, TemplatesActions())
    }

    /** Loaded, and genuinely none. The only state allowed to say so. */
    @Test
    fun noneYet_light() = capture("screen-templates-empty-light") {
        TemplatesContent(TemplatesViewModel.State(loaded = true), TemplatesActions())
    }

    /**
     * The first frame of every visit: empty, but not LOADED. Must not show the
     * "no templates yet" card, or a seller with ten templates sees "none" every
     * time they open the screen.
     */
    @Test
    fun stillLoading_light() = capture("screen-templates-loading-light") {
        TemplatesContent(
            TemplatesViewModel.State(loading = true, loaded = false),
            TemplatesActions(),
        )
    }

    /** The editor, open on an existing template with its specifics filled in. */
    @Test
    fun editor_light() = capture("screen-templates-editor-light") {
        TemplatesContent(
            loaded.copy(
                editingId = "t1",
                editing = TemplateDraft(
                    name = "Vintage denim",
                    descriptionTemplate = "Measured flat. Ships next business day.",
                    ebayCondition = "USED_EXCELLENT",
                    conditionDescription = "Light fading, no holes or repairs.",
                    ebayCategoryId = "11483",
                    itemSpecifics = mapOf("Department" to "Men", "Style" to "Straight"),
                    isDefault = true,
                ),
            ),
            TemplatesActions(),
        )
    }

    /**
     * A new template with no name yet. `canSave` is false, so Save must not
     * look pressable - the validation lives in the draft and shows up only here.
     */
    @Test
    fun newTemplateUnnamed_dark() = capture("screen-templates-editor-empty-dark", dark = true) {
        TemplatesContent(
            loaded.copy(editing = TemplateDraft()),
            TemplatesActions(),
        )
    }

    /** The delete dialog, and its promise that old listings are unaffected. */
    @Test
    fun deleteDialog_dark() = capture("screen-templates-delete-dark", dark = true) {
        TemplatesContent(loaded.copy(deleting = defaultTemplate), TemplatesActions())
    }

    /** The failure. */
    @Test
    fun error_dark() = capture("screen-templates-error-dark", dark = true) {
        TemplatesContent(
            loaded.copy(errorMessage = "Could not reach the server."),
            TemplatesActions(),
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
