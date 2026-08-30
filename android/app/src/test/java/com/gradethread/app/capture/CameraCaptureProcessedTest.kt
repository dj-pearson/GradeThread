package com.gradethread.app.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * US-2658: raw camera bytes must not reach [com.gradethread.app.upload.UploadWorker].
 *
 * THE DEFECT. `CaptureScreen.capture()` handed CameraX an output file and its
 * `onImageSaved` callback recorded THAT path. `PhotoProcessor` was never called
 * on the camera path — only the library picker reached it, through
 * `PhotoImport.importPicked`. So the same garment uploaded at 2048px with no
 * metadata if it was picked, and at full sensor resolution with whatever EXIF
 * CameraX wrote if it was shot. Three things followed, and only one of them is
 * about file size:
 *
 *  - the processor is what DESTROYS metadata (a fresh `Bitmap.compress` copies
 *    no EXIF at all), and the bytes go straight to Supabase Storage through a
 *    signed URL, so the server-side `stripImageMetadata()` never sees them
 *    either — both defences were bypassed by the same path;
 *  - the processor is what BAKES the orientation into the pixels, and eBay
 *    ignores the EXIF tag, so a shot kept upright only by that tag lists
 *    sideways;
 *  - iOS never had this shape: `PhotoIntakeView.swift:1025` compresses every
 *    camera shot before storing it, which is what made this a defect rather
 *    than a platform difference.
 *
 * WHY A SOURCE SCAN. The camera flow needs a device or an emulator; the
 * geometry is unit-testable and the WIRING is not. This is the same guard shape
 * as `DeleteReconcilerWiringTest` — it does not ask whether the processor
 * works, it asks whether it is called, which is the question that was wrong.
 */
class CameraCaptureProcessedTest {

    /** Source with comments stripped: a header describing a deleted call must not pass. */
    private fun source(path: String): String = File(path).readText()
        .replace(Regex("""/\*[\s\S]*?\*/"""), "")
        .replace(Regex("""(?m)^\s*//.*$"""), "")

    private val captureScreen by lazy {
        source("src/main/java/com/gradethread/app/capture/CaptureScreen.kt")
    }

    /**
     * The body of `capture()` alone.
     *
     * Scoped deliberately: the same file also holds the library-import
     * launcher, which has always called the processor by way of
     * `PhotoImport.importPicked`. A whole-file scan for "PhotoProcessor" would
     * therefore have passed against the broken code, because the import path
     * satisfies it — which is exactly the false pass this file exists to stop.
     */
    private val captureBody by lazy {
        val start = captureScreen.indexOf("fun capture() {")
        assertTrue("capture() is gone or was renamed", start > -1)
        // US-2902 AC3 moved the layout into CaptureContent, so capture() now
        // ends at the handoff rather than at the Column. The scope is still
        // the point: a whole-file scan passes against the broken code,
        // because the library-import path satisfies it.
        val end = captureScreen.indexOf("\n    CaptureContent(", start)
        assertTrue("the end of capture() moved — rescope this guard", end > start)
        captureScreen.substring(start, end)
    }

    @Test
    fun `the camera callback processes before it records`() {
        val process = captureBody.indexOf("PhotoProcessor.process(")
        assertTrue(
            "capture() must run PhotoProcessor on the shot — without it the upload " +
                "carries full sensor resolution and CameraX's EXIF",
            process > -1,
        )
        val record = captureBody.indexOf("recordCapture(")
        assertTrue("capture() no longer records the shot", record > -1)
        assertTrue(
            "the shot must be processed BEFORE it is recorded — recording first " +
                "puts the raw path in the store, and the store is what publishes",
            process < record,
        )
    }

    @Test
    fun `the raw file is never the recorded path`() {
        // The recorded argument must be the processor's output, not the file
        // handed to CameraX. Named `raw` on purpose so this reads as a claim.
        assertFalse(
            "capture() records the raw camera file",
            Regex("""recordCapture\(\s*raw""").containsMatchIn(captureBody),
        )
        assertTrue(
            "capture() must record the processor's output file",
            Regex("""recordCapture\(\s*out\.file\.absolutePath""").containsMatchIn(captureBody),
        )
    }

    @Test
    fun `the raw file is deleted on both outcomes`() {
        // Fail-closed: on success it is superseded, on failure it must not
        // linger where a later change could pick it up. One unconditional
        // delete, placed before the success branch, gives both.
        assertEquals(
            "expected exactly one unconditional raw.delete() in capture()",
            1,
            Regex("""raw\.delete\(\)""").findAll(captureBody).count(),
        )
        val delete = captureBody.indexOf("raw.delete()")
        val record = captureBody.indexOf("recordCapture(")
        assertTrue("raw.delete() must precede the record so it runs on both paths", delete < record)
    }

    @Test
    fun `a failed processing run surfaces instead of falling back to raw`() {
        assertTrue(
            "a processing failure must set captureError — the alternative to " +
                "telling the seller is uploading raw bytes silently",
            captureBody.contains("captureError = true"),
        )
        assertTrue(
            "the error state must be rendered, not just set",
            captureScreen.contains("R.string.capture_process_failed"),
        )
    }

    @Test
    fun `the destination slot is pinned before the shutter round trip`() {
        // The filename always pinned it; the map key did not. recordCapture
        // read activeSlot at CALLBACK time, so tapping another chip while the
        // shutter was in flight filed the photo under the new slot.
        val pin = captureBody.indexOf("val slot = state.activeSlot")
        assertTrue("capture() must pin the slot into a local before takePicture", pin > -1)
        val takePicture = captureBody.indexOf("controller.takePicture(")
        assertTrue("takePicture is gone or was renamed", takePicture > -1)
        assertTrue("the slot must be pinned BEFORE the shutter is fired", pin < takePicture)
        assertTrue(
            "the pinned slot must be passed to recordCapture — pinning it and " +
                "then not using it is the defect with extra steps",
            Regex("""recordCapture\([^)]*,\s*slot\s*\)""").containsMatchIn(captureBody),
        )
        assertFalse(
            "capture() must not read state.activeSlot again inside the callback",
            captureBody.substringAfter("onImageSaved").contains("state.activeSlot"),
        )
    }

    /**
     * Every entry point that puts a photo path into the pipeline runs the
     * processor. AC3: the guard cannot live only on the capture screen, because
     * the share target and the Snap flow are separate doors into the same
     * storage bucket.
     */
    @Test
    fun `every photo intake entry point runs the processor`() {
        val entryPoints = listOf(
            "src/main/java/com/gradethread/app/capture/CaptureScreen.kt",
            "src/main/java/com/gradethread/app/capture/PhotoImport.kt",
            "src/main/java/com/gradethread/app/intake/ShareTargetActivity.kt",
            "src/main/java/com/gradethread/app/snap/SnapViewModel.kt",
        )
        val missing = entryPoints.filterNot { source(it).contains("PhotoProcessor.process(") }
        assertEquals("these photo entry points do not process: $missing", emptyList<String>(), missing)
    }

    /**
     * Nothing NEW may enqueue an upload without going through one of those
     * doors. Only two call sites build an UploadWorker request, and both are
     * fed by a processed path — `CapturePublisher` from the intake store and
     * `ItemPhotosViewModel` from `PhotoImport`. A third would be an unreviewed
     * path to the bucket, so this pins the count rather than the contents.
     */
    @Test
    fun `only the two reviewed call sites enqueue an upload`() {
        val callers = File("src/main/java/com/gradethread/app")
            .walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .filterNot { it.path.replace('\\', '/').endsWith("upload/UploadWorker.kt") }
            .filter { source(it.path).contains("UploadWorker.request(") }
            .map { it.name }
            .sorted()
            .toList()
        assertEquals(
            "a new UploadWorker.request( call site appeared — prove its path is " +
                "processed and add it here",
            listOf("CapturePublisher.kt", "ItemPhotosViewModel.kt"),
            callers,
        )
    }
}
