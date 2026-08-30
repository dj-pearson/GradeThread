package com.gradethread.app.money

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

/**
 * US-3000 AC2: what the shared edge extraction returns, turned into a form the
 * seller confirms.
 *
 * The extraction itself is the server's -- one prompt, one model, one set of
 * confidence rules -- so what is worth testing here is the boundary: the date
 * the server sent must land as a UTC anchor and not as a device-zone moment,
 * and a scan that read nothing must still open a usable form.
 */
class ReceiptScanResultTest {

    private fun result(draft: ScannedDraft? = null, staging: String = "u/_staging/receipt_1.jpg") =
        ScanResult(stagingPath = staging, draft = draft)

    @Test
    fun theServersDateBecomesAUtcAnchor() {
        // AC3 at the receipt boundary. The server sends a bare YYYY-MM-DD for a
        // DATE column; parsing it in the device zone is exactly how US-2339
        // started, and a scanned expense would then be filed a day early for
        // every seller west of Greenwich.
        val d = result(ScannedDraft(spentOn = "2026-03-12", totalCents = 1234)).toDraft()
        assertEquals(CalendarDateField.startOfDayMs(LocalDate.of(2026, 3, 12)), d.spentOnMs)
        assertEquals("2026-03-12", ExpenseDraft.isoDate(d.spentOnMs))
    }

    @Test
    fun aMissingDateFallsBackToTodayAsAnAnchor() {
        val d = result(ScannedDraft(totalCents = 500)).toDraft()
        assertEquals(0L, d.spentOnMs % 86_400_000L)
    }

    @Test
    fun centsBecomeTheTextTheAmountFieldHolds() {
        // The field is the seller's typing until they save, so the model's
        // number arrives as text at 2dp rather than as a Double.
        assertEquals("12.34", result(ScannedDraft(totalCents = 1234)).toDraft().amountText)
        assertEquals("0.05", result(ScannedDraft(totalCents = 5)).toDraft().amountText)
        assertEquals("100.00", result(ScannedDraft(totalCents = 10000)).toDraft().amountText)
    }

    @Test
    fun aBlankAmountIsNotZero() {
        // "0.00" would be a number the seller has to notice and delete. Empty is
        // a field they have to fill, which is the honest state.
        assertEquals("", result(ScannedDraft(vendor = "Goodwill")).toDraft().amountText)
    }

    @Test
    fun readAnythingIsTheThingThatDecidesTheMessage() {
        // Either a total or a vendor is enough to be worth showing. Neither
        // means "type it in", not "the AI failed" -- which would invite a retry
        // that fails the same way.
        assertTrue(result(ScannedDraft(totalCents = 1)).readAnything)
        assertTrue(result(ScannedDraft(vendor = "Goodwill")).readAnything)
        assertFalse(result(ScannedDraft()).readAnything)
        assertFalse(result(null).readAnything)
    }

    @Test
    fun aBlankCategoryFallsBackRatherThanBeingSent() {
        // The server can legitimately decline to guess. An empty category would
        // fail the form's own validation, so the picker's default stands in.
        assertEquals(
            ExpenseDraft.DEFAULT_CATEGORY,
            result(ScannedDraft(category = "  ", totalCents = 1)).toDraft().category,
        )
        assertEquals(
            "shipping_supplies",
            result(ScannedDraft(category = "shipping_supplies", totalCents = 1))
                .toDraft().category,
        )
    }

    @Test
    fun theFileNameNamesTheFormatWithoutDecidingIt() {
        // US-276: the server sniffs magic bytes and ignores what we claim, so
        // this only makes the stored file legible.
        assertEquals("jpg", ReceiptScanService.extensionFor("image/jpeg"))
        assertEquals("png", ReceiptScanService.extensionFor("image/PNG"))
        assertEquals("pdf", ReceiptScanService.extensionFor("application/pdf"))
        assertEquals("jpg", ReceiptScanService.extensionFor("nonsense"))
    }

    @Test
    fun theAdoptPathIsTheOneTheWebUses() {
        // AC2 is about there being ONE implementation on the server. That only
        // holds if both clients call the same paths.
        assertEquals("/api/flipdesk/expenses/extract", ReceiptScanService.EXTRACT_PATH)
        assertEquals(
            "/api/flipdesk/expenses/abc/adopt-staged",
            ReceiptScanService.adoptPath("abc"),
        )
    }
}
