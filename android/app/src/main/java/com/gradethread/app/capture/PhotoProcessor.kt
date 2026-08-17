package com.gradethread.app.capture

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import androidx.exifinterface.media.ExifInterface
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import java.io.File

/**
 * US-1325: upload preprocessing (US-276 parity with the web/edge pipeline).
 *
 *  - DOWNSIZE to a 2048px long edge (never upscale), JPEG q80;
 *  - ORIENTATION BAKED INTO THE PIXELS via the source's EXIF transform —
 *    the eBay pipeline ignores EXIF, so upright must be physical;
 *  - METADATA GONE BY CONSTRUCTION: `Bitmap.compress` writes a fresh JPEG
 *    with NO EXIF at all — GPS, device serial, and timestamps can't leak
 *    because they're never copied (stronger than a whitelist: with the
 *    orientation baked in, even the orientation tag is unnecessary);
 *  - a 160px THUMBNAIL CACHE for the capture strip, keyed by source path +
 *    mtime so an edited source regenerates;
 *  - batched OFF-MAIN with bounded concurrency (decode is the memory hog —
 *    a 12-shot batch must not hold 12 full bitmaps at once).
 */
object PhotoProcessor {

    const val MAX_LONG_EDGE = 2048
    const val JPEG_QUALITY = 80
    const val THUMB_LONG_EDGE = 160
    const val MAX_CONCURRENT = 3

    /**
     * US-2639: the per-slot upload cap, keyed on `serverPhotoType` — the same
     * strings, and the same numbers, that web and iOS use.
     *
     * Android had none of this. Every photo compressed to [MAX_LONG_EDGE],
     * which is BELOW the web default, let alone the macro tiers: on the long
     * edge that is 43% fewer pixels than the other two on an authenticity slot
     * and 32% fewer on a tag, and by AREA — which is what a vision model reads
     * — 68% and 53% fewer.
     *
     * THE MEASUREMENT SLOT HAS A HARD NUMBER AND ANDROID FAILED IT. The
     * MeasureCard's fiducials are 1in squares and the detector needs ~40px
     * across each. A pair of pants laid flat fills ~50in of frame, so at 2048
     * the squares land at 41px BEFORE any server-side downscale — at the floor,
     * and under it for a larger garment or more margin. That is the same
     * argument US-2632 used to raise web from 2400 to 3600, and Android sat 15%
     * below where web was when web was judged too low.
     *
     * The tiers are not a new decision. Web and iOS carry byte-for-byte the
     * same table (`MACRO_UPLOAD_MAX_WIDTH_PX`, `CaptureSlot.uploadMaxLongEdge`),
     * so this is the third copy of one decision rather than a third opinion —
     * which is why [uploadCapFor] is pinned against the web source by a parity
     * test rather than merely unit-tested.
     */
    val UPLOAD_CAPS: Map<String, Int> = mapOf(
        // Authenticity evidence: the tell IS the fine detail — a struck serial,
        // a maker's mark, moulding seams. Plus the MeasureCard, which is not a
        // macro shot at all but needs the pixels for metrology.
        "serial" to 3600,
        "marking" to 3600,
        "surface" to 3600,
        "corner" to 3600,
        "sole" to 3600,
        "measurement" to 3600,
        // Tag and close-up slots: legibility of printed text and weave.
        "tag" to 3000,
        "label" to 3000,
        "detail" to 3000,
        "defect" to 3000,
        "interior" to 3000,
        "certificate" to 3000,
    )

    /**
     * The cap for a slot, falling back to [MAX_LONG_EDGE].
     *
     * ⚠ THE DEFAULT STAYS AT 2048 AND THAT IS A DECISION (US-2639 AC4), not an
     * oversight. The three platforms deliberately disagree here: web defaults
     * to 2400, iOS to 1600 — LOWERED on purpose for upload speed on mobile
     * data — and Android sits between them. Nothing in AC1's measurement
     * implicates the default; what it measured failing was the macro slots, and
     * those are fixed above. Raising every ordinary photo to the web number
     * would import a desktop tradeoff onto a mobile client that already sends
     * more than iOS does. Revisit it with a measurement about ordinary photos,
     * not by symmetry with a platform that is not on a phone.
     */
    fun uploadCapFor(serverPhotoType: String): Int = UPLOAD_CAPS[serverPhotoType] ?: MAX_LONG_EDGE

    data class Processed(val file: File, val width: Int, val height: Int)

    // ── Pure geometry (unit-tested) ──────────────────────────────────────────

    /** Output dimensions for a long-edge cap; never upscales. */
    fun targetDimensions(width: Int, height: Int, longEdge: Int = MAX_LONG_EDGE): Pair<Int, Int> {
        val currentLong = maxOf(width, height)
        if (currentLong <= longEdge) return width to height
        val scale = longEdge.toDouble() / currentLong
        return (width * scale).toInt().coerceAtLeast(1) to
            (height * scale).toInt().coerceAtLeast(1)
    }

    /** Power-of-two decode sample size that keeps the long edge >= target. */
    fun sampleSize(width: Int, height: Int, longEdge: Int = MAX_LONG_EDGE): Int {
        var sample = 1
        var currentLong = maxOf(width, height)
        while (currentLong / 2 >= longEdge) {
            sample *= 2
            currentLong /= 2
        }
        return sample
    }

    /** The pixel transform that makes an EXIF-oriented image upright. */
    fun matrixFor(exifOrientation: Int): Matrix? {
        val matrix = Matrix()
        when (exifOrientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> {
                matrix.postRotate(90f)
                matrix.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_TRANSVERSE -> {
                matrix.postRotate(270f)
                matrix.postScale(-1f, 1f)
            }
            else -> return null
        }
        return matrix
    }

    // ── Processing ───────────────────────────────────────────────────────────

    /**
     * Compress one photo into [outputDir]. Decode → bake orientation →
     * downsize → fresh JPEG (no metadata survives re-encode).
     */
    suspend fun process(source: File, outputDir: File, longEdge: Int = MAX_LONG_EDGE): Processed =
        withContext(Dispatchers.Default) {
            outputDir.mkdirs()

            // Bounds pass first so the real decode subsamples (memory).
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(source.absolutePath, bounds)
            val options = BitmapFactory.Options().apply {
                inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, longEdge)
            }
            val decoded = BitmapFactory.decodeFile(source.absolutePath, options)
                ?: error("undecodable image: ${source.name}")

            // Bake the EXIF orientation into the pixels.
            val exifOrientation = ExifInterface(source.absolutePath).getAttributeInt(
                ExifInterface.TAG_ORIENTATION,
                ExifInterface.ORIENTATION_NORMAL,
            )
            val upright = matrixFor(exifOrientation)?.let { matrix ->
                Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
                    .also { if (it !== decoded) decoded.recycle() }
            } ?: decoded

            // Exact downsize to the long-edge cap. `longEdge` rather than the
            // constant: this is the line the whole per-slot table exists to
            // reach (US-2639), and it never upscales, so a macro cap above the
            // sensor's own resolution is a no-op rather than a fake enlargement.
            val (w, h) = targetDimensions(upright.width, upright.height, longEdge)
            val sized = if (w != upright.width || h != upright.height) {
                Bitmap.createScaledBitmap(upright, w, h, true)
                    .also { if (it !== upright) upright.recycle() }
            } else {
                upright
            }

            val out = File(outputDir, "${source.nameWithoutExtension}_processed.jpg")
            out.outputStream().use { stream ->
                // A fresh JPEG: no EXIF is written — GPS/serial/time are gone.
                sized.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, stream)
            }
            val result = Processed(out, sized.width, sized.height)
            sized.recycle()
            result
        }

    /** Batch with bounded concurrency — at most [MAX_CONCURRENT] decodes live. */
    suspend fun processBatch(
        sources: List<File>,
        outputDir: File,
        maxConcurrent: Int = MAX_CONCURRENT,
    ): List<Result<Processed>> = coroutineScope {
        val semaphore = Semaphore(maxConcurrent)
        sources.map { source ->
            async {
                semaphore.withPermit { runCatching { process(source, outputDir) } }
            }
        }.awaitAll()
    }

    // ── Thumbnail cache (the strip) ──────────────────────────────────────────

    /**
     * 160px thumbnail, cached under [cacheDir] keyed by source name + mtime
     * so an edited source regenerates while an untouched one is a file hit.
     */
    suspend fun thumbnailFor(source: File, cacheDir: File): File = withContext(Dispatchers.Default) {
        cacheDir.mkdirs()
        val key = "${source.nameWithoutExtension}_${source.lastModified()}_thumb.jpg"
        val cached = File(cacheDir, key)
        if (cached.exists()) return@withContext cached

        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(source.absolutePath, bounds)
        val options = BitmapFactory.Options().apply {
            inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, THUMB_LONG_EDGE)
        }
        val decoded = BitmapFactory.decodeFile(source.absolutePath, options)
            ?: error("undecodable image: ${source.name}")
        val (w, h) = targetDimensions(decoded.width, decoded.height, THUMB_LONG_EDGE)
        val thumb = Bitmap.createScaledBitmap(decoded, w, h, true)
            .also { if (it !== decoded) decoded.recycle() }
        cached.outputStream().use { thumb.compress(Bitmap.CompressFormat.JPEG, 70, it) }
        thumb.recycle()
        cached
    }
}
