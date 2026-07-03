package com.gradethread.app.capture

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import androidx.exifinterface.media.ExifInterface
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

/** US-1327: capture-date extraction, pipeline reuse, per-pick isolation. */
@RunWith(RobolectricTestRunner::class)
class PhotoImportTest {

    @get:Rule
    val temp = TemporaryFolder()

    private var counter = 0

    private fun libraryJpeg(datetime: String? = null): File {
        val file = temp.newFile("lib_${counter++}.jpg")
        val bitmap = Bitmap.createBitmap(3000, 1500, Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(0xFF0F3460.toInt())
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it) }
        bitmap.recycle()
        if (datetime != null) {
            val exif = ExifInterface(file.absolutePath)
            exif.setAttribute(ExifInterface.TAG_DATETIME_ORIGINAL, datetime)
            exif.setLatLong(40.0, -74.0) // must NOT survive the pipeline
            exif.saveAttributes()
        }
        return file
    }

    @Test
    fun exifDateTime_parses_andRejectsGarbage() {
        val parsed = PhotoImport.parseExifDateTime("2026:07:03 10:15:30")!!
        assertTrue(parsed > 0)
        assertNull(PhotoImport.parseExifDateTime(null))
        assertNull(PhotoImport.parseExifDateTime(""))
        assertNull(PhotoImport.parseExifDateTime("not a date"))
    }

    @Test
    fun import_readsCaptureDateFromSource_thenRunsTheFullPipeline() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val source = libraryJpeg(datetime = "2025:01:15 08:30:00")
        val expectedDate = PhotoImport.parseExifDateTime("2025:01:15 08:30:00")!!

        val results = PhotoImport.importPicked(
            context,
            listOf(Uri.fromFile(source)),
            temp.newFolder("out"),
            now = { 999L },
        )
        val imported = results.single().getOrThrow()

        // Capture date came from the SOURCE EXIF, not the fallback.
        assertEquals(expectedDate, imported.captureDateMs)
        // The same pipeline ran: long edge capped + GPS destroyed.
        assertTrue(maxOf(imported.processed.width, imported.processed.height) <= PhotoProcessor.MAX_LONG_EDGE)
        assertNull(ExifInterface(imported.processed.file.absolutePath).latLong)
    }

    @Test
    fun missingExifDate_fallsBackToNow() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val results = PhotoImport.importPicked(
            context,
            listOf(Uri.fromFile(libraryJpeg())),
            temp.newFolder("out2"),
            now = { 123_456L },
        )
        assertEquals(123_456L, results.single().getOrThrow().captureDateMs)
    }

    @Test
    fun cap_andPerPickIsolation() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        // 9 picks + a broken one: only MAX_PICK are taken, breakage isolated.
        val uris = (1..9).map { Uri.fromFile(libraryJpeg()) } +
            Uri.fromFile(File(temp.root, "missing.jpg"))
        val results = PhotoImport.importPicked(context, uris, temp.newFolder("out3"))

        assertEquals(PhotoImport.MAX_PICK, results.size) // 8, the picker cap
        assertTrue(results.all { it.isSuccess }) // the broken pick fell past the cap
        assertEquals(8, PhotoImport.MAX_PICK)
    }
}
