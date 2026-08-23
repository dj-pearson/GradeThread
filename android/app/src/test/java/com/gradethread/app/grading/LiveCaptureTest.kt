package com.gradethread.app.grading

import com.gradethread.app.platform.net.EdgeApi
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-2802: Live Capture on Android.
 *
 * The badge claims the app WATCHED the photo being taken. That claim is only
 * as good as the bookkeeping behind it, so these cover the two ways it goes
 * wrong quietly: claiming it for a photo nobody watched, and losing it for one
 * we did.
 */
class LiveCaptureTest {

    private fun source(path: String) = File("src/main/java/com/gradethread/app/$path").readText()

    private fun image(type: String, from: String) = PhotoGradeImage(type, byteArrayOf(0xFF.toByte()), from)

    private val request = PhotoGradeRequest(
        garmentType = "tops",
        garmentCategory = "t-shirt",
        title = "Levis tee",
    )

    private val camera = PhotoGradeContract.IN_APP_CAPTURE_SOURCE
    private val library = PhotoGradeContract.LIBRARY_CAPTURE_SOURCE

    private fun fields(images: List<PhotoGradeImage>) = PhotoGradeUploader.body(images, request)
        .filterIsInstance<EdgeApi.Part.Field>()

    // ── the derivation ───────────────────────────────────────────────────

    @Test
    fun everyPhotoTakenInAppQualifies() {
        assertTrue(
            PhotoGradeContract.qualifiesForLiveCapture(listOf(camera, camera, camera)),
        )
    }

    @Test
    fun oneLibraryPhotoLosesIt() {
        // The claim is about the WHOLE submission. A single added photo makes
        // "every photo was taken here" false, and the server rejects the
        // combination outright rather than downgrading it.
        assertFalse(
            PhotoGradeContract.qualifiesForLiveCapture(listOf(camera, camera, library)),
        )
    }

    @Test
    fun anEmptySetIsNotLive_thoughAllWouldSayItIs() {
        // Collection.all is vacuously true on an empty collection. A submission
        // with no photos claiming the strongest provenance tier is exactly the
        // vacuous pass this refuses.
        assertFalse(PhotoGradeContract.qualifiesForLiveCapture(emptyList()))
    }

    // ── what actually goes on the wire ───────────────────────────────────

    @Test
    fun theOptInIsSentOnlyWhenEarned() {
        val live = fields(listOf(image("front", camera), image("back", camera), image("label", camera)))
        assertTrue(
            "an all-camera set did not claim the tier",
            live.any { it.name == PhotoGradeContract.LIVE_CAPTURE_OPT_IN_FIELD },
        )

        val mixed = fields(listOf(image("front", camera), image("back", library), image("label", camera)))
        assertFalse(
            "a mixed set claimed the tier — the server rejects that outright",
            mixed.any { it.name == PhotoGradeContract.LIVE_CAPTURE_OPT_IN_FIELD },
        )
    }

    @Test
    fun everyPhotoCarriesItsOwnSource() {
        // The badge needs BOTH the opt-in and the per-image sources; either
        // alone earns nothing.
        val sources = fields(
            listOf(image("front", camera), image("back", library), image("label", camera)),
        ).filter { it.name == PhotoGradeContract.CAPTURE_SOURCES_FIELD }.map { it.value }
        assertEquals(listOf(camera, library, camera), sources)
    }

    @Test
    fun theSourceDefaultsToLibrary_failingClosed() {
        // An origin nobody recorded must not be reported as live. The opposite
        // default hands out the strongest provenance badge on a bookkeeping
        // slip.
        val implicit = PhotoGradeImage("front", byteArrayOf(1))
        assertEquals(library, implicit.captureSource)
    }

    // ── the paths that may and may not claim it ──────────────────────────

    @Test
    fun onlyTheCameraPathRecordsAnInAppSource() {
        val vm = source("grading/ConsumerGradeViewModel.kt")
        val camerFn = vm.slice(vm.indexOf("fun addCameraShot")..vm.indexOf("fun addShot"))
        assertTrue(
            "the camera path does not record an in-app source",
            camerFn.contains("IN_APP_CAPTURE_SOURCE"),
        )
        val libraryFn = vm.slice(vm.indexOf("fun addShot")..vm.length - 1)
        assertTrue(
            "the library path claims in-app capture",
            !libraryFn.contains("IN_APP_CAPTURE_SOURCE"),
        )
    }

    @Test
    fun aLibraryPickOVERWRITESAnEarlierCameraShot() {
        // Retaking from the library after a camera shot must not keep the live
        // claim for that slot. Absent handling, the earlier in-app source would
        // survive in the map and the submission would claim a tier one of its
        // photos does not support.
        val vm = source("grading/ConsumerGradeViewModel.kt")
        // SCOPED TO addShot ALONE. The first version sliced to end-of-file and
        // stayed green when the line was deleted, because submit() below also
        // mentions LIBRARY_CAPTURE_SOURCE as its fallback. An assertion
        // satisfied by a later function is not guarding this one.
        val start = vm.indexOf("fun addShot")
        val next = vm.indexOf("    fun ", start + 10)
        val libraryFn = vm.substring(start, if (next > start) next else vm.length)
        assertTrue(
            "a library pick leaves the previous source in place",
            libraryFn.contains("LIBRARY_CAPTURE_SOURCE"),
        )
    }

    @Test
    fun theCaptureFilesAreNotLeftBehind() {
        // CameraX writes the shot to filesDir and PhotoProcessor writes a
        // second file beside it. The draft keeps the BYTES, so after a capture
        // nothing reads either file again - and nothing else ever visits that
        // directory, so a retake that keeps both is app storage the person
        // never gets back.
        val sheet = source("grading/GradeCameraSheet.kt")
        val saved = sheet.substring(sheet.indexOf("fun onImageSaved"))
        val body = saved.substring(0, saved.indexOf("override fun onError"))
        assertTrue("the camera file is left behind", body.contains("raw.delete()"))
        assertTrue(
            "the processed file is left behind",
            body.contains("processed?.file?.delete()"),
        )
    }

    @Test
    fun theCameraPathRunsTheProcessorToo() {
        // US-2658: it did not once, while the library path did — so the same
        // garment uploaded at full sensor resolution with EXIF intact if shot
        // in-app, and downsized with none if picked. The processor is what
        // bakes orientation into the pixels, and the grading pipeline ignores
        // the EXIF tag.
        assertTrue(
            source("grading/GradeCameraSheet.kt").contains("PhotoProcessor.process("),
        )
    }
}
