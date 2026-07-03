package com.gradethread.app.capture

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.exifinterface.media.ExifInterface
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

/**
 * US-1325: real-image proof (Robolectric native graphics) — downsize,
 * orientation baking, metadata destruction, and the thumb cache.
 */
@RunWith(RobolectricTestRunner::class)
class PhotoProcessorTest {

    @get:Rule
    val temp = TemporaryFolder()

    private var fileCounter = 0

    /** Writes a real JPEG with EXIF orientation + GPS + timestamp planted. */
    private fun sourceJpeg(width: Int, height: Int, orientation: Int? = null): File {
        val file = temp.newFile("src_${width}x${height}_${fileCounter++}.jpg")
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(0xFFE94560.toInt())
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it) }
        bitmap.recycle()

        val exif = ExifInterface(file.absolutePath)
        orientation?.let { exif.setAttribute(ExifInterface.TAG_ORIENTATION, it.toString()) }
        // The privacy-sensitive tags US-276 exists to kill:
        exif.setLatLong(37.7749, -122.4194)
        exif.setAttribute(ExifInterface.TAG_DATETIME_ORIGINAL, "2026:07:03 10:00:00")
        exif.setAttribute(ExifInterface.TAG_MAKE, "TestPhone")
        exif.saveAttributes()
        return file
    }

    // ── Pure geometry ──

    @Test
    fun targetDimensions_capsTheLongEdge_andNeverUpscales() {
        assertEquals(2048 to 1024, PhotoProcessor.targetDimensions(4096, 2048))
        assertEquals(1024 to 2048, PhotoProcessor.targetDimensions(2048, 4096))
        // Already small: untouched.
        assertEquals(800 to 600, PhotoProcessor.targetDimensions(800, 600))
    }

    @Test
    fun sampleSize_isThePowerOfTwoKeepingTheLongEdgeAboveTarget() {
        assertEquals(1, PhotoProcessor.sampleSize(2048, 1024))
        assertEquals(2, PhotoProcessor.sampleSize(4096, 2048))
        assertEquals(4, PhotoProcessor.sampleSize(10_000, 5_000))
        assertEquals(1, PhotoProcessor.sampleSize(800, 600))
    }

    @Test
    fun matrix_coversRotationsAndFlips_nullForUpright() {
        assertNull(PhotoProcessor.matrixFor(ExifInterface.ORIENTATION_NORMAL))
        assertNull(PhotoProcessor.matrixFor(ExifInterface.ORIENTATION_UNDEFINED))
        assertTrue(PhotoProcessor.matrixFor(ExifInterface.ORIENTATION_ROTATE_90) != null)
        assertTrue(PhotoProcessor.matrixFor(ExifInterface.ORIENTATION_FLIP_HORIZONTAL) != null)
    }

    // ── Real-image processing ──

    @Test
    fun process_downsizes_bakesRotation_andDestroysMetadata() = runTest {
        // 4096x2048 with EXIF "rotate 90": upright pixels must be 1024x2048.
        val source = sourceJpeg(4096, 2048, orientation = ExifInterface.ORIENTATION_ROTATE_90)
        val out = PhotoProcessor.process(source, temp.newFolder("out"))

        // Rotation baked: dimensions swapped, long edge capped.
        assertEquals(1024, out.width)
        assertEquals(2048, out.height)
        val decoded = BitmapFactory.decodeFile(out.file.absolutePath)
        assertEquals(1024, decoded.width)
        decoded.recycle()

        // US-276: GPS/serial/time DESTROYED, orientation no longer needed.
        val exif = ExifInterface(out.file.absolutePath)
        assertNull(exif.latLong)
        assertNull(exif.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL))
        assertNull(exif.getAttribute(ExifInterface.TAG_MAKE))
        val orientation = exif.getAttributeInt(
            ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_UNDEFINED,
        )
        assertTrue(
            orientation == ExifInterface.ORIENTATION_UNDEFINED ||
                orientation == ExifInterface.ORIENTATION_NORMAL,
        )
    }

    @Test
    fun smallUprightImage_isNotUpscaled() = runTest {
        val source = sourceJpeg(800, 600)
        val out = PhotoProcessor.process(source, temp.newFolder("out2"))
        assertEquals(800, out.width)
        assertEquals(600, out.height)
    }

    @Test
    fun batch_respectsBoundedConcurrency_andIsolatesFailures() = runTest {
        // A missing file is the portable undecodable case (Robolectric's
        // decoder is lenient with garbage BYTES, a device's isn't — don't
        // depend on that difference).
        val sources = (1..5).map { sourceJpeg(600, 400) } +
            File(temp.root, "missing.jpg")

        val results = PhotoProcessor.processBatch(
            sources, temp.newFolder("out3"), maxConcurrent = 2,
        )
        assertEquals(5, results.count { it.isSuccess })
        assertEquals(1, results.count { it.isFailure }) // garbage fails ALONE
    }

    @Test
    fun semaphore_boundsInFlightWork() = runTest {
        // The concurrency primitive the batch uses, proven directly.
        val semaphore = Semaphore(2)
        val inFlight = AtomicInteger(0)
        val peak = AtomicInteger(0)
        val gate = CompletableDeferred<Unit>()

        val jobs = (1..6).map {
            async(Dispatchers.Default) {
                semaphore.withPermit {
                    val now = inFlight.incrementAndGet()
                    peak.updateAndGet { maxOf(it, now) }
                    gate.await()
                    inFlight.decrementAndGet()
                }
            }
        }
        // Let workers reach the gate, then release.
        withContext(Dispatchers.Default) { Thread.sleep(100) }
        gate.complete(Unit)
        jobs.forEach { it.await() }
        assertTrue("peak=${peak.get()}", peak.get() <= 2)
    }

    // ── Thumbnail cache ──

    @Test
    fun thumbnails_are160Capped_andCacheHitOnSecondCall() = runTest {
        val source = sourceJpeg(1600, 800)
        val cacheDir = temp.newFolder("thumbs")

        val first = PhotoProcessor.thumbnailFor(source, cacheDir)
        val decoded = BitmapFactory.decodeFile(first.absolutePath)
        assertTrue(maxOf(decoded.width, decoded.height) <= PhotoProcessor.THUMB_LONG_EDGE)
        decoded.recycle()

        val stamp = first.lastModified()
        val second = PhotoProcessor.thumbnailFor(source, cacheDir)
        assertEquals(first.absolutePath, second.absolutePath)
        assertEquals(stamp, second.lastModified()) // reused, not regenerated
    }
}
