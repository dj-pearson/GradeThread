package com.gradethread.app.platform.storage

import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

/**
 * US-2895: [StagedMedia.clearAll] against a real filesystem.
 *
 * [StagedMediaCoverageTest] proves the LIST is complete; this proves the delete
 * works — including the two properties a sign-out path depends on: it removes
 * nested content, and it never throws.
 */
@RunWith(RobolectricTestRunner::class)
class StagedMediaTest {

    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

    private fun plant(): List<File> = StagedMedia.directories(context).map { dir ->
        // Nested, not a flat file: a capture session writes subdirectories, and
        // `delete()` (as opposed to `deleteRecursively()`) silently fails on a
        // non-empty directory and returns false rather than throwing.
        File(dir, "session/photo.jpg").apply {
            parentFile?.mkdirs()
            writeText("garment")
        }
    }

    @Test
    fun `clears every directory it lists`() = runTest {
        val planted = plant()
        assertTrue("setup failed to plant files", planted.all { it.exists() })

        assertTrue("clearAll reported failure", StagedMedia.clearAll(context))

        val survivors = StagedMedia.directories(context).filter { it.exists() }
        assertEquals("directories left behind after sign-out: $survivors", emptyList<File>(), survivors)
    }

    @Test
    fun `removes nested content, not just the top level`() = runTest {
        val planted = plant()
        StagedMedia.clearAll(context)
        assertFalse("a nested photo survived", planted.any { it.exists() })
    }

    @Test
    fun `succeeds when nothing has been staged`() = runTest {
        // The common case: a seller who signs out without ever taking a photo.
        // An absent directory is not a failure, and reporting one would tell
        // them bytes were left behind when none ever existed.
        StagedMedia.clearAll(context)
        assertTrue("a second clear reported failure", StagedMedia.clearAll(context))
    }

    @Test
    fun `covers both roots`() = runTest {
        // A list that accidentally resolved everything against one root would
        // still pass the tests above while leaving the other root untouched.
        val dirs = StagedMedia.directories(context)
        assertTrue("no cacheDir entries", dirs.any { it.path.startsWith(context.cacheDir.path) })
        assertTrue("no filesDir entries", dirs.any { it.path.startsWith(context.filesDir.path) })
        assertEquals(
            "directories() lost or duplicated an entry",
            StagedMedia.CACHE_DIRS.size + StagedMedia.FILES_DIRS.size,
            dirs.size,
        )
    }

    @Test
    fun `never deletes the roots themselves`() = runTest {
        // An empty string or a stray "." in the list would resolve to cacheDir
        // itself and take the whole cache — including things that are not this
        // seller's to lose.
        plant()
        StagedMedia.clearAll(context)
        assertTrue("cacheDir itself was deleted", context.cacheDir.exists())
        assertTrue("filesDir itself was deleted", context.filesDir.exists())
    }
}
