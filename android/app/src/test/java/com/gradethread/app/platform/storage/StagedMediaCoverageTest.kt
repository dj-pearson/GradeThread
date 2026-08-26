package com.gradethread.app.platform.storage

import com.gradethread.app.upload.UploadWorker
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * US-2895: [StagedMedia] must not fall behind the code.
 *
 * Sign-out emptied Room and left the garment photos on disk. The fix is a list
 * of every staging directory, and a list is only as good as the thing that stops
 * it going stale — nothing about writing `File(context.cacheDir, "new-thing")`
 * in a new feature reminds anyone that sign-out has to clear it, and the failure
 * is silent: the next account simply inherits a directory of someone else's
 * photos.
 *
 * So this scans `src/main` for every `cacheDir`/`filesDir` literal and fails
 * when one is neither listed nor explicitly excluded with a reason. It is a
 * source scan for the same reason [com.gradethread.app.sync.DeleteReconcilerWiringTest]
 * is one: the question is not "does clearAll work" but "does clearAll know about
 * everything", which no amount of testing the function itself can answer.
 */
class StagedMediaCoverageTest {

    /**
     * Directories that are deliberately NOT cleared at sign-out.
     *
     * Every entry needs a reason. An exclusion list without reasons becomes the
     * place things get quietly dropped, which is the failure this file exists to
     * prevent, one level up.
     */
    private val excluded = mapOf(
        "intake-inbox" to
            "IntakeInboxStore.clearAll owns it and drops Room rows too; " +
            "clearing the directory from here would leave those rows pointing at nothing",
    )

    /**
     * Files where a `cacheDir`/`filesDir` match is not a directory CHOICE.
     *
     * Reasons required, same as [excluded], and for the same reason: an
     * exclusion list without them becomes the quiet place things get dropped.
     */
    private val notADirectoryChoice = mapOf(
        "StagedMedia.kt" to
            "the definition itself — `CACHE_DIRS.map { File(context.cacheDir, it) }` is the list, not a user of it",
        "PhotoProcessor.kt" to
            "`thumbnailFor(source, cacheDir)` RECEIVES its directory as a parameter, so coverage " +
            "is decided at the call site, not here (US-2895 fixed a caller that passed the cache root)",
    )

    private fun sources(): List<File> = File("src/main/java/com/gradethread/app")
        .walkTopDown()
        .filter { it.isFile && it.extension == "kt" && it.name !in notADirectoryChoice }
        .toList()

    /** Comments stripped: a directory named only in prose is not a directory anyone clears. */
    private fun body(file: File): String = file.readText()
        .replace(Regex("""/\*[\s\S]*?\*/"""), "")
        .replace(Regex("""(?m)^\s*//.*$"""), "")

    /**
     * `File(cacheDir, X)` where X is a string literal OR an identifier.
     *
     * ⚠ THE IDENTIFIER CASE IS NOT OPTIONAL, and leaving it out is how the
     * first version of this file was wrong. It matched only `"literals"`, so
     * `AccountExportService`'s `File(context.cacheDir, DIR)` — with
     * `const val DIR = "account-export"` — was invisible. That showed up as a
     * false STALE report, which is the harmless direction; the dangerous
     * direction is the same blindness in the missing check, where a new feature
     * naming its directory through a constant would never be flagged at all.
     */
    private val call = Regex("""File\(\s*(?:context\.)?(cacheDir|filesDir)\s*,\s*("[^"]+"|[A-Za-z_][A-Za-z0-9_]*)""")

    /** `const val NAME = "value"` in one file, for resolving the identifier case. */
    private val constant = Regex("""const val ([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*String\s*)?=\s*"([^"]+)"""")

    private val unresolved = mutableListOf<String>()

    /** Every (root, name) pair the app actually constructs, with where it came from. */
    private fun found(): Map<Pair<String, String>, String> = buildMap {
        unresolved.clear()
        for (f in sources()) {
            val text = body(f)
            val consts = constant.findAll(text).associate { it.groupValues[1] to it.groupValues[2] }
            for (m in call.findAll(text)) {
                val raw = m.groupValues[2]
                val name = if (raw.startsWith("\"")) {
                    raw.trim('"')
                } else {
                    // Resolvable in the same file, or not resolvable at all.
                    // Anything unresolved is recorded and FAILS below rather
                    // than being dropped: "could not tell" and "nothing to
                    // report" must not look the same.
                    consts[raw] ?: run {
                        unresolved += "${f.name}: ${m.groupValues[1]}, $raw"
                        null
                    }
                } ?: continue
                put(m.groupValues[1] to name, f.name)
            }
        }
    }

    @Test
    fun `every staging directory is listed or excluded with a reason`() {
        val missing = found().filterKeys { (root, name) ->
            if (name in excluded) return@filterKeys false
            name !in if (root == "cacheDir") StagedMedia.CACHE_DIRS else StagedMedia.FILES_DIRS
        }
        assertTrue(
            "These directories hold a seller's files and nothing clears them at sign-out. " +
                "Add each to StagedMedia, or to this test's `excluded` map WITH A REASON: " +
                missing.entries.joinToString { "${it.key.first}/${it.key.second} (${it.value})" },
            missing.isEmpty(),
        )
    }

    @Test
    fun `the list contains nothing the app no longer creates`() {
        // A stale entry is harmless to run and corrosive to trust: it makes the
        // list look maintained while the real question — is anything missing —
        // goes unasked.
        val actual = found().keys
        val stale = buildList {
            for (d in StagedMedia.CACHE_DIRS) if ("cacheDir" to d !in actual) add("cacheDir/$d")
            for (d in StagedMedia.FILES_DIRS) if ("filesDir" to d !in actual) add("filesDir/$d")
        }
        assertEquals("StagedMedia lists directories no source file creates: $stale", emptyList<String>(), stale)
    }

    @Test
    fun `every directory name the scan meets can be resolved`() {
        // A `File(cacheDir, someVariable)` this scan cannot resolve is a
        // directory nobody can prove is cleared. Failing here is the point:
        // the alternative is dropping it silently, which reads as coverage.
        found()
        assertEquals(
            "unresolvable staging-directory names (make them a `const val` in the same file): " + unresolved,
            emptyList<String>(),
            unresolved.toList(),
        )
    }

    @Test
    fun `no source hands a bare cache or files root to something that writes into it`() {
        // US-2895, found by sabotage: every other assertion here passes when a
        // caller swaps `File(context.cacheDir, "autolister")` for a bare
        // `context.cacheDir`, because that produces NO directory literal for
        // the scan to miss. The files then land loose in the root, beside the
        // directories StagedMedia clears, and sign-out steps over them.
        //
        // That is exactly what AutolisterSessionViewModel was doing: 160px
        // thumbnails of a seller's garments, written to the top of the cache.
        //
        // There are legitimately zero of these, so the invariant is simply
        // "none". `File(context.cacheDir, "name")` does not match — the root is
        // followed by a comma, not a closing paren.
        val bareRoot = Regex("""[(,]\s*(?:context\.)?(cacheDir|filesDir)\s*\)""")
        val offenders = sources().flatMap { f ->
            bareRoot.findAll(body(f)).map { "${f.name}: ${it.value.trim()}" }
        }
        assertEquals(
            "A bare cache/files root is being passed as a directory. Whatever writes there " +
                "puts files OUTSIDE every directory StagedMedia clears, so they survive sign-out. " +
                "Pass a named subdirectory instead: " + offenders,
            emptyList<String>(),
            offenders,
        )
    }

    @Test
    fun `the scan actually finds things`() {
        // Guards the guard. A regex that silently stops matching reports an
        // empty `missing` set, which is indistinguishable from full coverage —
        // the exact way a source scan passes against broken code.
        assertTrue("the cacheDir/filesDir scan matched nothing at all", found().size >= 10)
    }

    @Test
    fun `every scan-excluded file still exists`() {
        // A file exclusion that outlives its file is a hole nobody can see:
        // the name silently matches nothing, and the reason beside it keeps
        // asserting the exclusion is still needed.
        val names = sources().map { it.name }.toSet() +
            File("src/main/java/com/gradethread/app").walkTopDown().map { it.name }.toSet()
        for (f in notADirectoryChoice.keys) {
            assertTrue("`$f` is excluded from the scan but no longer exists", f in names)
        }
    }

    @Test
    fun `excluded directories are real, not leftovers`() {
        val names = found().keys.map { it.second }.toSet()
        for (name in excluded.keys) {
            assertTrue("`$name` is excluded but no source file creates it", name in names)
        }
    }

    @Test
    fun `sign-out cancels uploads by the tag the worker actually applies`() {
        // The cancel and the tag must not drift. A cancel written against a
        // copy-pasted string keeps compiling after a rename and cancels
        // nothing, which at an account boundary means the outgoing seller's
        // photos keep uploading.
        val worker = body(File("src/main/java/com/gradethread/app/upload/UploadWorker.kt"))
        assertTrue("UploadWorker no longer tags requests with TAG_ALL", worker.contains(".addTag(TAG_ALL)"))
        assertTrue(
            "UploadWorker.cancelAll no longer cancels by TAG_ALL",
            worker.contains("cancelAllWorkByTag(TAG_ALL)"),
        )
        assertEquals("photo-upload", UploadWorker.TAG_ALL)
    }

    @Test
    fun `tearDownSession wires the upload cancel and both photo clearances`() {
        // Scoped to tearDownSession, not the whole file: a whole-file scan
        // cannot tell a call from a declaration, and this file has already been
        // through that lesson once (see DeleteReconcilerWiringTest's header).
        val settings = body(File("src/main/java/com/gradethread/app/settings/SettingsViewModel.kt"))
        val start = settings.indexOf("private suspend fun tearDownSession(")
        assertTrue("tearDownSession is gone or was renamed", start > -1)
        val end = settings.indexOf("\n    private ", start + 1).let { if (it > -1) it else settings.length }
        val fn = settings.substring(start, end)

        assertTrue("sign-out no longer cancels in-flight uploads", fn.contains("UploadWorker.cancelAll"))
        assertTrue("sign-out no longer clears staged photos", fn.contains("StagedMedia.clearAll"))
        assertTrue("sign-out no longer clears the Coil disk cache", fn.contains("diskCache?.clear()"))
        assertTrue("sign-out no longer clears the Coil memory cache", fn.contains("memoryCache?.clear()"))
    }
}
