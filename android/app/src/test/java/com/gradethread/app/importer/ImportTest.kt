package com.gradethread.app.importer

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage
import com.gradethread.app.ui.text
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1389: the CSV import.
 *
 * A migration writes hundreds of rows that are tedious to undo, so every rule
 * that decides what gets written is checked here. The locale price rule in
 * particular: getting it wrong puts a hundred-fold error into a cost basis that
 * then flows into every profit figure the seller sees.
 */
@RunWith(RobolectricTestRunner::class)
class ImportTest {

    private val context = ApplicationProvider.getApplicationContext<Context>()

    // ── Parsing ──────────────────────────────────────────────────────────────

    @Test
    fun `quoted fields, escaped quotes and embedded newlines survive`() {
        val sheet = CsvParser.parseSheet(
            "title,notes\n\"Levi's 501\",\"Says \"\"vintage\"\" on the tag\nsecond line\"\n",
        )

        assertEquals(listOf("title", "notes"), sheet.headers)
        assertEquals(1, sheet.rows.size)
        assertEquals("Levi's 501", sheet.rows[0][0])
        assertEquals("Says \"vintage\" on the tag\nsecond line", sheet.rows[0][1])
    }

    @Test
    fun `a BOM does not glue itself to the first header`() {
        // Excel and Sheets "CSV UTF-8" exports prepend one, and trimming
        // whitespace does not remove it — so auto-mapping would silently miss
        // exactly the first column.
        val sheet = CsvParser.parseSheet("﻿title,brand\nJacket,Levi's\n")

        assertEquals("title", sheet.headers.first())
        assertEquals(ImportField.TITLE, ImportField.guess(sheet.headers.first()))
    }

    @Test
    fun `tabs and semicolons are detected`() {
        assertEquals(CsvParser.Delimiter.TAB, CsvParser.detectDelimiter("a\tb\tc"))
        // European-locale exports.
        assertEquals(CsvParser.Delimiter.SEMICOLON, CsvParser.detectDelimiter("a;b;c"))
        assertEquals(CsvParser.Delimiter.COMMA, CsvParser.detectDelimiter("a,b,c"))
    }

    @Test
    fun `ragged rows are padded and truncated to the header width`() {
        val sheet = CsvParser.parseSheet("a,b,c\n1,2\n1,2,3,4\n")

        assertTrue(sheet.rows.all { it.size == 3 })
        assertEquals("", sheet.rows[0][2])
        assertEquals("3", sheet.rows[1][2])
    }

    @Test
    fun `trailing blank lines do not become empty items`() {
        val sheet = CsvParser.parseSheet("title\nJacket\n\n\n")
        assertEquals(1, sheet.rows.size)
    }

    @Test
    fun `windows line endings do not leave a carriage return on the last column`() {
        val sheet = CsvParser.parseSheet("title,brand\r\nJacket,Levi's\r\n")
        assertEquals("Levi's", sheet.rows[0][1])
    }

    // ── Header guessing ──────────────────────────────────────────────────────

    @Test
    fun `headers map at any casing or spacing`() {
        assertEquals(ImportField.TITLE, ImportField.guess("Item Title"))
        assertEquals(ImportField.PURCHASE_PRICE, ImportField.guess("  purchase price "))
        assertEquals(ImportField.COLOR, ImportField.guess("Colour"))
        assertEquals(ImportField.SKU, ImportField.guess("Item #"))
    }

    @Test
    fun `an unknown header skips rather than guessing`() {
        // Silently importing "Location" into "Notes" is worse than making the
        // seller point at it themselves.
        assertEquals(ImportField.SKIP, ImportField.guess("Storage location"))
    }

    // ── Prices ───────────────────────────────────────────────────────────────

    @Test
    fun `prices parse in any locale`() {
        assertEquals(19.99, ImportValue.price("$19.99")!!, 0.001)
        assertEquals(1299.0, ImportValue.price("1,299")!!, 0.001)
        // The one that matters: naive stripping turns this into 1.29900.
        assertEquals(1299.0, ImportValue.price("1.299,00")!!, 0.001)
        assertEquals(5.0, ImportValue.price("5,00")!!, 0.001)
        assertEquals(1000000.0, ImportValue.price("1,000,000")!!, 0.001)
    }

    @Test
    fun `an accounting negative is negative, a parenthetical note is not`() {
        assertEquals(-5.0, ImportValue.price("(5.00)")!!, 0.001)
        assertEquals(20.0, ImportValue.price("$20 (sale)")!!, 0.001)
    }

    @Test
    fun `an unparseable price is null, never zero`() {
        // Zero would read as "this cost nothing", which is a real claim.
        assertNull(ImportValue.price("n/a"))
        assertNull(ImportValue.price(""))
        assertNull(ImportValue.price(null))
    }

    // ── Statuses, categories, dates ──────────────────────────────────────────

    @Test
    fun `statuses normalize, and an unknown one is null`() {
        assertEquals("listed", ImportValue.status("Active"))
        assertEquals("acquired", ImportValue.status("bought"))
        assertEquals("cataloged", ImportValue.status("catalogued"))
        // Mapping "pending" to "listed" would tell a seller stock is live when
        // it isn't; null lets the default stand instead.
        assertNull(ImportValue.status("pending"))
    }

    @Test
    fun `categories normalize across spellings`() {
        assertEquals("clothing", ImportValue.category("Apparel"))
        assertEquals("shoes", ImportValue.category("Sneakers"))
        assertEquals("jewelry", ImportValue.category("Jewellery"))
        assertEquals("bags", ImportValue.category("Handbag"))
        assertNull(ImportValue.category("furniture"))
    }

    @Test
    fun `dates parse in the common spreadsheet shapes`() {
        assertEquals("2026-07-31", ImportValue.dateIso("2026-07-31"))
        assertEquals("2026-03-04", ImportValue.dateIso("03/04/2026"))
        assertEquals("2026-03-04", ImportValue.dateIso("3/4/2026"))
        assertEquals("2026-07-31", ImportValue.dateIso("2026/07/31"))
        assertNull(ImportValue.dateIso("last Tuesday"))
        assertNull(ImportValue.dateIso(""))
    }

    // ── Planning ─────────────────────────────────────────────────────────────

    private fun sheetOf(vararg lines: String) = CsvParser.parseSheet(lines.joinToString("\n") + "\n")

    @Test
    fun `a mapping with no title cannot be committed`() {
        // A Continue button that leads to "0 of 400 imported" is worse than a
        // disabled one that says why.
        assertTrue(Importer.mappingError(listOf(ImportField.SKU, ImportField.BRAND)) != null)
        assertNull(Importer.mappingError(listOf(ImportField.TITLE)))
    }

    @Test
    fun `rows map onto drafts, with 1-based sheet row numbers`() {
        val sheet = sheetOf("title,sku,cost", "Jacket,A1,19.99", "Boots,B2,45")
        val plan = Importer.plan(sheet, Importer.guessMapping(sheet.headers), emptySet())

        assertEquals(2, plan.ready.size)
        // Row 2 is the first data row — the header is row 1, as the seller sees
        // it in their spreadsheet.
        assertEquals(2, plan.ready[0].sheetRow)
        assertEquals("Jacket", plan.ready[0].title)
        assertEquals(19.99, plan.ready[0].acquiredPrice!!, 0.001)
        assertEquals(3, plan.ready[1].sheetRow)
    }

    @Test
    fun `a row with no title is rejected, and says so`() {
        val sheet = sheetOf("title,sku", "Jacket,A1", ",B2")
        val plan = Importer.plan(sheet, Importer.guessMapping(sheet.headers), emptySet())

        assertEquals(1, plan.ready.size)
        assertEquals(listOf(3), plan.rejected.map { it.sheetRow })
        assertEquals("No item title", plan.rejected.single().reason.text(context))
    }

    @Test
    fun `a SKU already in inventory is skipped, not duplicated`() {
        val sheet = sheetOf("title,sku", "Jacket,A1", "Boots,B2")
        val plan = Importer.plan(sheet, Importer.guessMapping(sheet.headers), setOf("a1"))

        assertEquals(listOf("Boots"), plan.ready.map { it.title })
        assertEquals(1, plan.duplicates.size)
        // US-2976: the SKU is an ARGUMENT now, not spliced into the sentence,
        // so assert it there. That also makes the check locale-free.
        val duplicate = plan.duplicates.single().reason
        assertEquals(R.string.import_reject_duplicate_sku, duplicate.res)
        assertEquals("A1", duplicate.args[0])
    }

    @Test
    fun `an in-batch duplicate keeps the first row`() {
        val sheet = sheetOf("title,sku", "Jacket,A1", "Jacket again,A1")
        val plan = Importer.plan(sheet, Importer.guessMapping(sheet.headers), emptySet())

        assertEquals(listOf("Jacket"), plan.ready.map { it.title })
        assertEquals(listOf(3), plan.duplicates.map { it.sheetRow })
    }

    @Test
    fun `rows with no SKU are all imported`() {
        // Blank SKUs must not collide with each other.
        val sheet = sheetOf("title,sku", "Jacket,", "Boots,")
        val plan = Importer.plan(sheet, Importer.guessMapping(sheet.headers), emptySet())

        assertEquals(2, plan.ready.size)
        assertTrue(plan.duplicates.isEmpty())
    }

    @Test
    fun `a fully blank row is ignored entirely`() {
        val sheet = CsvParser.Sheet(listOf("title"), listOf(listOf("Jacket"), listOf("")))
        val plan = Importer.plan(sheet, listOf(ImportField.TITLE), emptySet())

        assertEquals(1, plan.ready.size)
        assertTrue(plan.rejected.isEmpty())
    }

    @Test
    fun `status defaults rather than being guessed`() {
        val sheet = sheetOf("title,status", "Jacket,pending")
        val plan = Importer.plan(sheet, Importer.guessMapping(sheet.headers), emptySet())

        assertEquals(Importer.DEFAULT_STATUS, plan.ready.single().status)
    }

    // ── Copy ─────────────────────────────────────────────────────────────────

    @Test
    fun `the summary names what will NOT be imported`() {
        // A seller migrating 400 rows needs to know 12 are being skipped
        // BEFORE they commit, not after.
        val plan = ImportPlan(
            ready = List(388) { ImportDraft(sheetRow = it + 2, title = "x") },
            duplicates = List(10) {
                ImportRejection(it, UiMessage(R.string.import_reject_duplicate_sku, args = listOf("A$it")))
            },
            rejected = List(2) { ImportRejection(it, UiMessage(R.string.import_reject_no_title)) },
        )

        assertEquals(
            "388 of 400 rows ready · 10 already in your inventory · 2 missing a title",
            Importer.summary(plan).text(context),
        )
    }

    @Test
    fun `the outcome counts every kind of result`() {
        // US-2976: no trailing full stop. The line is a LIST of clauses joined
        // by a separator, and only this one of the two ever ended in one -
        // summary() never did. A period belongs to a sentence.
        assertEquals(
            "Imported 1 item",
            Importer.outcome(inserted = 1, skipped = 0).text(context),
        )
        assertEquals(
            "Imported 12 items · 3 skipped as duplicates · 1 couldn't be saved",
            Importer.outcome(inserted = 12, skipped = 3, failed = 1).text(context),
        )
    }

    /**
     * US-2976: the joined line, in the other language.
     *
     * The English clauses hide two mistakes a translator can make - a plural
     * whose "one" form was left as the "other", and a separator that should
     * have changed. This renders the four-clause worst case in Spanish, where
     * both singular and plural forms differ.
     */
    @Test
    @Config(qualifiers = "es")
    fun `the Spanish outcome agrees with its own numbers`() {
        assertEquals(
            "1 art\u00edculo importado",
            Importer.outcome(inserted = 1, skipped = 0).text(context),
        )
        assertEquals(
            "12 art\u00edculos importados \u00b7 3 omitidos por duplicados \u00b7 " +
                "1 no se pudo guardar",
            Importer.outcome(inserted = 12, skipped = 3, failed = 1).text(context),
        )
    }

    @Test
    fun `queued rows are not called failures`() {
        // A queued row is going to land. Calling it a failure would send a
        // seller off to redo a migration that is already finishing itself.
        assertEquals(
            "Imported 0 items · 40 waiting to send when you're back online",
            Importer.outcome(inserted = 0, skipped = 0, queued = 40).text(context),
        )
    }
}
