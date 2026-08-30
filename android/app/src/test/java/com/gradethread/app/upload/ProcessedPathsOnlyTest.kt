package com.gradethread.app.upload

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * US-2658 AC3: an unprocessed file must not be able to reach [UploadWorker].
 *
 * THE DEFECT THIS GUARDS. `CaptureScreen.capture()` recorded the RAW CameraX
 * output and `UploadWorker` PUT those exact bytes at a signed Supabase URL. The
 * processor is what downsizes, what destroys EXIF (a fresh `Bitmap.compress`
 * copies none) and what bakes the orientation into the pixels, so skipping it
 * bypassed BOTH metadata defences at once - the client's and the server's
 * `stripImageMetadata()`, which never sees a signed-URL upload.
 *
 * WHY THIS GUARD IS NOT ON THE CAPTURE SCREEN. The story asked for it here
 * precisely because capture is not the only door. `ShareTargetActivity` writes
 * into the same intake store from another app's share sheet, `ItemPhotosViewModel`
 * enqueues uploads directly from the photo grid, and `SnapViewModel` stages its
 * own file. A guard pinned to one screen says nothing about the other three.
 *
 * WHAT IT ACTUALLY CHECKS. Two chokepoints, discovered rather than listed:
 *
 *  1. every construction of `UploadWorker.Input(`, whose `stagedPath` must name
 *     a processed value;
 *  2. every write of a path into the intake store's photo map - `recordCapture`,
 *     `setPhoto`, and the share-sheet merge in `IntakeInbox` - since the capture
 *     plan reads its paths straight back out of that map.
 *
 * A path is "processed" when its expression names a `PhotoProcessor.process()`
 * result, directly or through a local binding. Two expressions are allowed to
 * name something already inside a producer's own structure ([DELEGATED]); each
 * has to keep matching, so that list can only shrink.
 *
 * ⚠ THE SELF-TEST IS THE POINT. A source scan that stops matching reports a
 * clean codebase, which is what a broken guard and a correct one look like from
 * the outside. [selfCheck] runs the same matcher over the shape of the original
 * defect and fails if it passes.
 */
class ProcessedPathsOnlyTest {

    private val mainSrc = File("src/main/java/com/gradethread/app")

    /**
     * Expressions that name a value inside a producer's own structure, with the
     * producer that fills it. Each MUST still be found; an entry that stops
     * matching fails, so this list can only shrink.
     */
    private val delegated = mapOf(
        // CapturePublishPlan copies the intake store's map into its entries,
        // and every write into that map is checked by [storeWritesAreProcessed].
        "entry.stagedPath" to "CapturePublishPlan",
        // IntakeInbox merges the share sheet's batch, whose entries
        // ShareTargetActivity fills from PhotoProcessor output.
        "entry.path" to "ShareTargetActivity",
    )

    private fun sources(): List<Pair<String, String>> = mainSrc.walkTopDown()
        .filter { it.isFile && it.extension == "kt" }
        .map { it.path.replace('\\', '/').substringAfter("com/gradethread/app/") to strip(it.readText()) }
        .toList()

    /** Comments removed: a header describing a deleted call must not pass. */
    private fun strip(text: String): String = text
        .replace(Regex("""/\*[\s\S]*?\*/"""), "")
        .replace(Regex("""(?m)//.*$"""), "")

    /**
     * Local names bound, directly or transitively, to a processor result.
     *
     * Transitive because the camera path binds twice - `runCatching { process }`
     * and then `getOrNull()` - and a matcher that only saw the first would
     * reject the correct code.
     */
    private fun processedLocals(src: String): Set<String> {
        // ONE LINE PER BINDING, deliberately. A version that let a binding run
        // on across indented continuation lines swallowed the very next `val`:
        // `val cap = PhotoProcessor.uploadCapFor(` ate
        // `val processed = runCatching { PhotoProcessor.process(`, so the
        // camera path's two hops were never bound and the correct code failed.
        // Missing a multi-line binding costs a false FAILURE, which is loud.
        // Swallowing one costs a false pass on the exact defect this guards.
        val bindings = Regex("""val\s+(\w+)\s*(?::[^=\n]+)?=\s*([^\n]*)""")
            .findAll(src)
            .map { it.groupValues[1] to it.groupValues[2] }
            .toList()
        val processed = mutableSetOf<String>()
        repeat(3) {
            bindings.forEach { (name, expr) ->
                val fromProcessor = expr.contains("PhotoProcessor.process(") ||
                    expr.contains(".processed") ||
                    processed.any { Regex("""\b$it\b""").containsMatchIn(expr) }
                if (fromProcessor) processed += name
            }
        }
        return processed
    }

    private fun isProcessed(expr: String, locals: Set<String>): Boolean {
        val e = expr.trim().removeSuffix(",").trim()
        if (e in delegated) return true
        if (e.contains(".processed")) return true
        if (e.contains("PhotoProcessor.process(")) return true
        val root = e.takeWhile { it.isLetterOrDigit() || it == '_' }
        return root.isNotEmpty() && root in locals
    }

    /** The `stagedPath = …` argument of every `UploadWorker.Input(` in a file. */
    private fun uploadInputPaths(src: String): List<String> = Regex("""UploadWorker\.Input\(([\s\S]{0,900}?)\n\s*\)""")
        .findAll(src)
        .mapNotNull { Regex("""stagedPath\s*=\s*([^\n]+)""").find(it.groupValues[1])?.groupValues?.get(1) }
        .toList()

    /** Every path written into the intake store's photo map, from one file. */
    private fun storeWrites(name: String, src: String): List<String> {
        val out = mutableListOf<String>()
        if (!name.endsWith("capture/PhotoIntakeStore.kt")) {
            out += Regex("""\.recordCapture\(\s*([^,)\n]+)""").findAll(src).map { it.groupValues[1] }
            // The first argument is a plain slot reference, never a nested
            // call. Allowing one made `viewModel.setPhoto(stageFromUri(context,
            // it))` in SnapScreen read as a two-argument store write of `it` -
            // a different class, a different method, and not a store at all.
            out += Regex("""\.setPhoto\(\s*[A-Za-z_][\w.]*\s*,\s*([^,)\n]+)\)""")
                .findAll(src).map { it.groupValues[1] }
        }
        // `=(?!=)` because the share-sheet merge also ASKS `photos[x] == null`
        // to find a free slot, and a bare `=` matched the second half of that
        // and reported `= null }` as a path being written.
        out += Regex("""photos\[[^\]]+\]\s*=(?!=)\s*([^\n]+)""").findAll(src).map { it.groupValues[1] }
        return out.filter { it.isNotBlank() }
    }

    @Test
    fun `every UploadWorker input names a processed file`() {
        var checked = 0
        sources().forEach { (name, src) ->
            val locals = processedLocals(src)
            uploadInputPaths(src).forEach { expr ->
                checked += 1
                assertTrue(
                    "$name enqueues an upload from `${expr.trim()}`, which does not name a " +
                        "PhotoProcessor result. Raw camera bytes carry full sensor resolution, " +
                        "CameraX's EXIF and an orientation only a tag makes upright - and a " +
                        "signed-URL upload never reaches the server's stripImageMetadata().",
                    isProcessed(expr, locals),
                )
            }
        }
        assertTrue("no UploadWorker.Input construction found - rescope this guard", checked >= 2)
    }

    @Test
    fun `every path written into the intake store is processed`() {
        var checked = 0
        sources().forEach { (name, src) ->
            val locals = processedLocals(src)
            storeWrites(name, src).forEach { expr ->
                checked += 1
                assertTrue(
                    "$name puts `${expr.trim()}` into the capture store. The publish plan reads " +
                        "its upload paths straight back out of that map, so an unprocessed " +
                        "value here is an unprocessed upload one hop later.",
                    isProcessed(expr, locals),
                )
            }
        }
        assertTrue("no store write found - rescope this guard", checked >= 3)
    }

    @Test
    fun `every delegated expression is still in use`() {
        val all = sources()
        delegated.forEach { (expr, producer) ->
            val used = all.any { (_, src) ->
                uploadInputPaths(src).any { it.trim().removeSuffix(",").trim() == expr } ||
                    storeWrites("x", src).any { it.trim().removeSuffix(",").trim() == expr }
            }
            assertTrue(
                "`$expr` is allowed through because $producer fills it, and nothing uses it " +
                    "any more. Delete the entry rather than leaving a hole open.",
                used,
            )
            assertTrue(
                "$producer no longer exists, so `$expr` is allowed through on a promise " +
                    "nobody keeps",
                all.any { (name, _) -> name.contains(producer) },
            )
        }
    }

    /**
     * The matcher, run against the shape of the original defect.
     *
     * Without this a rename that made every regex miss would report a clean
     * codebase, which is exactly what a working guard reports.
     */
    @Test
    fun selfCheck() {
        val broken = """
            fun capture() {
                val raw = File(dir, "front.jpg")
                controller.takePicture(raw) {
                    intake.recordCapture(raw.absolutePath, slot)
                }
            }
        """.trimIndent()
        val brokenWrites = storeWrites("capture/CaptureScreen.kt", broken)
        assertEquals("the store-write matcher stopped finding recordCapture", 1, brokenWrites.size)
        assertTrue(
            "the matcher accepts a RAW camera file - it would have passed the US-2658 defect",
            !isProcessed(brokenWrites.first(), processedLocals(broken)),
        )

        val brokenUpload = """
            val staged = File(dir, "front.jpg")
            work.enqueue(
                UploadWorker.request(
                    UploadWorker.Input(
                        stagedPath = staged.absolutePath,
                        itemId = itemId,
                    ),
                ),
            )
        """.trimIndent()
        val paths = uploadInputPaths(brokenUpload)
        assertEquals("the upload-input matcher stopped finding stagedPath", 1, paths.size)
        assertTrue(
            "the matcher accepts an unprocessed staged file",
            !isProcessed(paths.first(), processedLocals(brokenUpload)),
        )

        val good = """
            val processed = runCatching { PhotoProcessor.process(raw, dir, cap) }
            val out = processed.getOrNull() ?: return
            intake.recordCapture(out.file.absolutePath, slot)
        """.trimIndent()
        val goodWrites = storeWrites("capture/CaptureScreen.kt", good)
        assertEquals(1, goodWrites.size)
        assertTrue(
            "the matcher REJECTS the correct two-hop camera path, so it would fail the app " +
                "as written and get relaxed until it caught nothing",
            isProcessed(goodWrites.first(), processedLocals(good)),
        )
    }
}
