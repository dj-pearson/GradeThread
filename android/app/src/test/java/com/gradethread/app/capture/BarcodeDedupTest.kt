package com.gradethread.app.capture

import com.google.mlkit.vision.barcode.common.Barcode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1332: the scan-to-SKU repeat-suppression rule.
 *
 * The clock is injected as a plain millis argument, so the 1s window is
 * proven without waiting a real second or touching a camera.
 */
class BarcodeDedupTest {

    @Test
    fun firstDetectionEmits() {
        val d = BarcodeDedup()
        assertTrue(d.shouldEmit("012345678905", 0L))
    }

    @Test
    fun singleShot_suppressesEveryLaterFrameOfTheSameScan() {
        val d = BarcodeDedup()
        assertTrue(d.shouldEmit("012345678905", 0L))
        // ~30fps over a barcode held steady. Without the latch a single scan
        // fires dozens of times and the SKU field thrashes.
        for (frame in 1..60) {
            assertFalse(
                "frame $frame re-emitted",
                d.shouldEmit("012345678905", frame * 33L),
            )
        }
    }

    @Test
    fun singleShot_holdsEvenLongAfterTheWindowLapses() {
        val d = BarcodeDedup()
        assertTrue(d.shouldEmit("012345678905", 0L))
        // The latch is not a timeout — only rearm/reset re-opens emission.
        assertFalse(d.shouldEmit("012345678905", 60_000L))
    }

    @Test
    fun singleShot_suppressesADifferentCodeToo() {
        val d = BarcodeDedup()
        assertTrue(d.shouldEmit("012345678905", 0L))
        // One scan session yields exactly one SKU; a second barcode drifting
        // into frame must not silently overwrite the one just accepted.
        assertFalse(d.shouldEmit("5901234123457", 10L))
    }

    @Test
    fun rearm_stillSuppressesTheSameCodeInsideTheWindow() {
        val d = BarcodeDedup()
        assertTrue(d.shouldEmit("012345678905", 0L))
        d.rearm()
        // The barcode is still sitting in frame — re-firing here would
        // overwrite the SKU the user just accepted.
        assertFalse(d.shouldEmit("012345678905", 999L))
    }

    @Test
    fun rearm_allowsTheSameCodeOnceTheWindowLapses() {
        val d = BarcodeDedup()
        assertTrue(d.shouldEmit("012345678905", 0L))
        d.rearm()
        assertTrue(d.shouldEmit("012345678905", 1_000L))
    }

    @Test
    fun rearm_allowsADifferentCodeImmediately() {
        val d = BarcodeDedup()
        assertTrue(d.shouldEmit("012345678905", 0L))
        d.rearm()
        // Scanning a genuinely different tag is intent, not a repeat.
        assertTrue(d.shouldEmit("5901234123457", 5L))
    }

    @Test
    fun reset_allowsTheSameCodeImmediately() {
        val d = BarcodeDedup()
        assertTrue(d.shouldEmit("012345678905", 0L))
        d.reset()
        // A fresh presentation of the scanner: the user came back deliberately,
        // quite possibly to re-scan the very same tag.
        assertTrue(d.shouldEmit("012345678905", 1L))
    }

    @Test
    fun emptyPayloadsNeverEmit() {
        val d = BarcodeDedup()
        // A decoded-but-empty barcode must not blank the SKU field.
        assertFalse(d.shouldEmit("", 0L))
        // ...and must not consume the single shot.
        assertTrue(d.shouldEmit("012345678905", 1L))
    }

    @Test
    fun windowIsOneSecond() {
        assertEquals(1_000L, BarcodeDedup.DEFAULT_WINDOW_MILLIS)
    }

    @Test
    fun enabledFormatsMatchIos() {
        assertEquals(
            listOf(
                Barcode.FORMAT_EAN_13,
                Barcode.FORMAT_EAN_8,
                Barcode.FORMAT_UPC_E,
                Barcode.FORMAT_CODE_128,
                Barcode.FORMAT_QR_CODE,
            ),
            BarcodeFormats.enabled,
        )
    }

    @Test
    fun upcAIsNotEnabled() {
        // Vision reports UPC-A as EAN-13 with a leading zero, so iOS stores
        // the 13-digit shape. Enabling FORMAT_UPC_A here would hand back the
        // bare 12-digit payload and the same physical barcode would scan to a
        // different SKU on each platform, breaking the duplicate lookup.
        assertFalse(BarcodeFormats.enabled.contains(Barcode.FORMAT_UPC_A))
    }

    @Test
    fun skuNormalizationTrimsSurroundingWhitespace() {
        // The trim is why the duplicate pre-check and the insert agree on one
        // string — see the iOS asymmetry called out in normalizeScannedSku.
        assertEquals("012345678905", normalizeScannedSku("  012345678905\n"))
    }

    @Test
    fun skuNormalizationLeavesVendorPayloadsIntact() {
        // A consignment QR can legitimately encode a vendor's own SKU format.
        assertEquals("AB-1234/X", normalizeScannedSku("AB-1234/X"))
    }
}
