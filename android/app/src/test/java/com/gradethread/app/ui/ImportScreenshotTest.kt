package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.importer.CsvParser
import com.gradethread.app.importer.ImportActions
import com.gradethread.app.importer.ImportContent
import com.gradethread.app.importer.ImportDraft
import com.gradethread.app.importer.ImportField
import com.gradethread.app.importer.ImportPlan
import com.gradethread.app.importer.ImportRejection
import com.gradethread.app.importer.ImportViewModel
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over bringing an existing inventory in.
 *
 * ⚠ FOUR STEPS SHARE ONE SCREEN. Pick, map, preview and done are the same
 * Column with different children, so a step that rendered the wrong body would
 * not crash - it would put a seller on Import with a mapping they never
 * checked. All four are captured.
 *
 * ⚠ AND THE PREVIEW IS WHERE DROPPED ROWS GET NAMED. An import that silently
 * skipped what it could not read would produce a smaller inventory than the
 * file held, with nothing on screen saying which rows went missing. The fixture
 * therefore rejects two rows and flags one duplicate against six ready ones,
 * so the counts have to disagree with the file's total.
 *
 * ⚠ THE MAPPING FIXTURE INCLUDES A SKIP. A column the seller chose not to
 * import must look different from one that has not been decided yet, and both
 * are on screen at once here.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class ImportScreenshotTest {

    private val sheet = CsvParser.Sheet(
        headers = listOf("SKU", "Title", "Brand", "Size", "Paid", "Internal note"),
        rows = listOf(
            listOf("PAT-BS-M", "Patagonia Better Sweater", "Patagonia", "M", "24.00", "back room"),
            listOf("BAR-BED-L", "Barbour Bedale Wax Jacket", "Barbour", "L", "68.00", "rail 3"),
            listOf("", "Uniqlo Oxford Shirt", "Uniqlo", "S", "6.00", ""),
        ),
    )

    private val mapping = listOf(
        ImportField.SKU,
        ImportField.TITLE,
        ImportField.BRAND,
        ImportField.SIZE,
        ImportField.PURCHASE_PRICE,
        // Chosen NOT to import. Must not look like an undecided column.
        ImportField.SKIP,
    )

    private val plan = ImportPlan(
        ready = List(6) { i ->
            ImportDraft(
                sheetRow = i + 2,
                title = "Item ${i + 1}",
                sku = "SKU-${i + 1}",
                brand = "Patagonia",
                size = "M",
                acquiredPrice = 24.00 + i,
            )
        },
        duplicates = listOf(ImportRejection(sheetRow = 8, reason = "SKU PAT-BS-M is already in your inventory")),
        // ⚠ ONLY ONE REJECTION REASON EXISTS AT THE PLAN STAGE, and it has to
        // be this one. Importer.summary hard-codes the wording - it counts
        // plan.rejected and calls every one of them "missing a title" - which
        // is true today because ImportPlan.plan() rejects for nothing else.
        // The first version of this fixture invented "Paid is not a number"
        // and the golden read "2 missing a title" above a row that said
        // otherwise: a picture of a bug the app does not have.
        rejected = listOf(
            ImportRejection(sheetRow = 9, reason = "No item title"),
            ImportRejection(sheetRow = 12, reason = "No item title"),
        ),
    )

    @Test
    fun pickStep_light() = capture("screen-import-pick-light") {
        ImportContent(ImportViewModel.State(), ImportActions())
    }

    @Test
    fun pickStep_dark() = capture("screen-import-pick-dark", dark = true) {
        ImportContent(ImportViewModel.State(), ImportActions())
    }

    /** A sheet link typed in, ready to fetch. */
    @Test
    fun sheetUrlTyped_light() = capture("screen-import-sheeturl-light") {
        ImportContent(
            ImportViewModel.State(sheetUrl = "https://docs.google.com/spreadsheets/d/not-a-real-id/edit"),
            ImportActions(),
        )
    }

    /** Mapping, with one column deliberately skipped. */
    @Test
    fun mapStep_light() = capture("screen-import-map-light") {
        ImportContent(
            ImportViewModel.State(step = ImportViewModel.Step.MAP, sheet = sheet, mapping = mapping),
            ImportActions(),
        )
    }

    /**
     * The preview, where six ready rows sit beside one duplicate and two
     * rejections. The counts must not add up to the file's row count in
     * silence.
     */
    @Test
    fun previewStep_light() = capture("screen-import-preview-light") {
        ImportContent(
            ImportViewModel.State(
                step = ImportViewModel.Step.PREVIEW,
                sheet = sheet,
                mapping = mapping,
                plan = plan,
            ),
            ImportActions(),
        )
    }

    @Test
    fun previewStep_dark() = capture("screen-import-preview-dark", dark = true) {
        ImportContent(
            ImportViewModel.State(
                step = ImportViewModel.Step.PREVIEW,
                sheet = sheet,
                mapping = mapping,
                plan = plan,
            ),
            ImportActions(),
        )
    }

    /** Finished, with the rows that did not make it still named. */
    @Test
    fun doneStep_light() = capture("screen-import-done-light") {
        ImportContent(
            ImportViewModel.State(
                step = ImportViewModel.Step.DONE,
                plan = plan,
                outcome = "Added 6 items.",
                failures = plan.rejected,
            ),
            ImportActions(),
        )
    }

    /** A file that could not be read at all. */
    @Test
    fun error_dark() = capture("screen-import-error-dark", dark = true) {
        ImportContent(
            ImportViewModel.State(error = "That file has no header row."),
            ImportActions(),
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
