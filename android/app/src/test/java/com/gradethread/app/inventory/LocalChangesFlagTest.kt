package com.gradethread.app.inventory

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * US-2341: an item edit must stop reporting unsaved changes once the server has
 * it.
 *
 * WHY THIS IS A SOURCE GUARD RATHER THAN A VIEWMODEL TEST. The rule itself is
 * one boolean; what actually broke was the WIRING. `applyLocally` stamps
 * `hasLocalChanges = true` on every edit, and the only code that ever cleared it
 * was `MutationReplayer.mirrorLocally`, which runs on the offline REPLAY path.
 * An online save therefore never cleared it: the canvas kept reporting unsaved
 * changes, and the sync engine's conflict policy kept defending a row with
 * nothing left to defend. Nothing in this repo constructs a ViewModel in a unit
 * test (the one exception is `feedback/`), so pinning the call site is the
 * honest instrument, in the shape `ResponseCacheTenantGuardTest` already uses.
 */
class LocalChangesFlagTest {

    private fun source(relative: String): String {
        val file = File("src/main/java/com/gradethread/app/$relative")
        assertTrue(
            "$relative is gone or moved, so this guard is scanning nothing. " +
                "Re-anchor it rather than deleting it.",
            file.isFile,
        )
        return file.readText()
    }

    /**
     * Comments stripped, and that is load-bearing rather than tidy.
     *
     * The dirty-flag comment in `ItemCanvasViewModel` quotes the very literals
     * these tests search for, so scanning the raw text meant the guard could be
     * satisfied by PROSE ABOUT the rule while the code that implements it was
     * gone. Caught by a sabotage: deleting the real assignment left the third
     * case green off the comment alone. This repo has hit that before -
     * `guards-that-read-source-must-strip-comments`.
     */
    private fun stripComments(text: String): String = text
        .replace(Regex("""/\*[\s\S]*?\*/"""), " ")
        .replace(Regex("""(?m)//.*$"""), " ")

    private val canvas by lazy { stripComments(source("inventory/ItemCanvasViewModel.kt")) }

    /** The `onSuccess` block of the save, up to the `onFailure` that follows. */
    private fun saveSuccessBlock(): String {
        val start = canvas.indexOf("}.onSuccess {")
        assertTrue("the save's onSuccess block was renamed or restructured", start > -1)
        val end = canvas.indexOf("}.onFailure {", start)
        assertTrue("the save's onFailure block was renamed or restructured", end > start)
        return canvas.substring(start, end)
    }

    @Test
    fun `a successful online save clears the local-changes flag`() {
        val block = saveSuccessBlock()
        assertTrue(
            "the save's success path does not clear hasLocalChanges. Without it " +
                "an online save leaves the row marked dirty forever - the canvas " +
                "reports unsaved changes and the sync conflict policy defends a " +
                "row the server already has.",
            Regex("""hasLocalChanges\s*=\s*false""").containsMatchIn(block),
        )
    }

    @Test
    fun `the clear is skipped while an aspect write-back is still queued`() {
        val block = saveSuccessBlock()
        val clearAt = block.indexOf("hasLocalChanges = false")
        val guardAt = block.indexOf("if (!queued)")
        assertTrue(
            "the clear must be gated on the aspect write-back having landed. A " +
                "queued write-back has NOT reached the server, and clearing the " +
                "flag there tells the next pull to prefer the server's older copy.",
            guardAt in 0..<clearAt,
        )
    }

    @Test
    fun `an edit still marks the row dirty in the first place`() {
        // The other direction, and the reason it is worth asserting: "clear the
        // flag on save" is also satisfied by never setting it, which would look
        // identical from the canvas and would quietly disable the offline
        // conflict defence entirely.
        assertTrue(
            "applyLocally no longer stamps hasLocalChanges = true, so nothing " +
                "marks an edit as unsynced and the clear above guards nothing.",
            Regex("""hasLocalChanges\s*=\s*true""").containsMatchIn(canvas),
        )
    }
}
