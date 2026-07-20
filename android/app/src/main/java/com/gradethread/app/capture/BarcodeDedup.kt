package com.gradethread.app.capture

import com.google.mlkit.vision.barcode.common.Barcode

/**
 * US-1332: which symbologies we scan, and the repeat-suppression rule.
 *
 * Ported from the iOS `BarcodeScanner`. Kept as plain logic with an injected
 * clock so the timing rule is unit-testable without a camera or a real one
 * second of wall time.
 */
object BarcodeFormats {

    /**
     * The five symbologies iOS enables, and only those.
     *
     * UPC-A is deliberately ABSENT. Vision reports a UPC-A barcode as EAN-13
     * with a leading zero, so iOS SKUs are stored in that 13-digit shape.
     * ML Kit treats `FORMAT_UPC_A` as its own format and would hand back the
     * bare 12-digit payload — the same physical barcode would then scan to a
     * different SKU string on each platform and stop matching the duplicate
     * lookup in `IntakeRepository.findBySku`.
     */
    val enabled: List<Int> = listOf(
        Barcode.FORMAT_EAN_13,
        Barcode.FORMAT_EAN_8,
        Barcode.FORMAT_UPC_E,
        Barcode.FORMAT_CODE_128,
        Barcode.FORMAT_QR_CODE,
    )
}

/**
 * Single-shot emission plus a repeat-suppression window.
 *
 * Two independent guards, mirroring iOS:
 *
 *  - **single-shot**: once a code is emitted the dedup disarms, so one scan
 *    session yields exactly one SKU no matter how many frames still carry the
 *    barcode. The camera runs at ~30fps over a barcode the user is holding
 *    steady, so without this a single scan fires dozens of times.
 *  - **window**: the same code re-emitting within [windowMillis] is
 *    suppressed. On iOS this guard is unreachable — the latch always wins and
 *    the stream closes in the same breath — so it is documented there as a
 *    dead backstop. Here it is load-bearing, because [rearm] lets a caller
 *    scan again WITHOUT dismissing the scanner: rearming deliberately keeps
 *    the last-code memory, so the barcode still sitting in frame doesn't
 *    instantly re-fire and overwrite the SKU the user just accepted.
 *
 * Not thread-safe by construction: ML Kit analyzer callbacks are delivered on
 * a single executor, which is the only caller. That mirrors iOS serializing
 * the check-and-set onto the main actor.
 */
class BarcodeDedup(private val windowMillis: Long = DEFAULT_WINDOW_MILLIS) {

    private var lastCode: String? = null
    private var lastEmittedAt: Long = Long.MIN_VALUE
    private var armed: Boolean = true

    /**
     * @return true if [code] should be delivered to the caller now.
     */
    fun shouldEmit(code: String, nowMillis: Long): Boolean {
        if (code.isEmpty()) return false
        if (!armed) return false
        val previous = lastCode
        if (previous == code && nowMillis - lastEmittedAt < windowMillis) return false
        lastCode = code
        lastEmittedAt = nowMillis
        armed = false
        return true
    }

    /**
     * Allow one more emission, KEEPING the last-code memory so the window
     * still suppresses the barcode currently in frame. For scan-again without
     * leaving the scanner.
     */
    fun rearm() {
        armed = true
    }

    /**
     * Full reset for a brand new scan session — forgets the last code, so an
     * immediate re-scan of the SAME barcode is allowed. This is what a fresh
     * presentation of the scanner wants: the user deliberately came back to
     * scan, and quite possibly the very same tag.
     */
    fun reset() {
        lastCode = null
        lastEmittedAt = Long.MIN_VALUE
        armed = true
    }

    companion object {
        /** iOS `dedupeWindow` — 1.0s. */
        const val DEFAULT_WINDOW_MILLIS: Long = 1_000L
    }
}

/**
 * Normalize a raw barcode payload into a SKU.
 *
 * Deliberate divergence from iOS, which assigns `payloadStringValue` to
 * `form.sku` untrimmed and then trims only on SOME downstream paths — the
 * duplicate pre-check trims, the insert does not. A payload with trailing
 * whitespace therefore checks for collisions under one string and is stored
 * under another, so the "SKU already in use" guard silently misses. Trimming
 * once here, at the single point of assignment, makes the two agree.
 *
 * QR payloads are otherwise left verbatim: a QR code on a consignment tag can
 * legitimately encode a vendor's own SKU format, and second-guessing it would
 * corrupt real data.
 */
fun normalizeScannedSku(raw: String): String = raw.trim()
