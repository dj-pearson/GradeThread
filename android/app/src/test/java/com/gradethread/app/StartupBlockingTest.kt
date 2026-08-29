package com.gradethread.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * US-2900 AC4: nothing on the Application.onCreate path blocks the main thread.
 *
 * A SOURCE SCAN, and worth being honest about what it can and cannot do. It
 * cannot prove a call is fast, and it cannot see a block that happens inside a
 * library. What it CAN do is fail the moment `runBlocking` reappears in one of
 * the files `GradeThreadApp.onCreate` reaches, which is the regression this
 * exists to catch - two of them were there, both with a comment calling the
 * work "one small disk read", and both were a DataStore first-collection
 * (create the store, open the file, parse it) on the critical path of every
 * cold start.
 *
 * The pattern returns because it is the shortest way to answer "what is the
 * stored value" from a non-suspending function, and Application.onCreate is
 * non-suspending. That is precisely why a guard is worth more here than a
 * comment.
 */
class StartupBlockingTest {

    private val appRoot = File("src/main/java/com/gradethread/app")

    /**
     * The files Application.onCreate touches directly.
     *
     * Deliberately a NAMED LIST rather than a transitive walk. A walk would
     * pull in most of the app and turn this into a repo-wide ban on
     * `runBlocking`, which is a different and much harder rule - there are
     * legitimate uses off the startup path. This list is the startup path, and
     * it is short enough to keep honest by hand.
     */
    private val startupFiles = listOf(
        "GradeThreadApp.kt",
        "MainActivity.kt",
        "platform/applock/AppLock.kt",
        "platform/telemetry/Telemetry.kt",
        "platform/workspace/WorkspaceScope.kt",
    )

    private fun source(relative: String): String? {
        val f = File(appRoot, relative)
        return if (f.isFile) f.readText() else null
    }

    @Test
    fun `every file named here still exists`() {
        // Guards the guard. A rename this list did not follow would make every
        // assertion below vacuous, and a vacuous scan reads exactly like a
        // clean one - which is mode 6 of the repo's guards-that-do-not-guard
        // list.
        val missing = startupFiles.filter { source(it) == null }
        assertEquals("startup files this guard names but cannot find: $missing", emptyList<String>(), missing)
    }

    @Test
    fun `no runBlocking on the Application onCreate path`() {
        val offenders = startupFiles.filter { rel ->
            val src = source(rel) ?: return@filter false
            // Strip comments first. Both of the original offenders are DESCRIBED
            // in comments now - Telemetry.kt says "It used to do
            // `runBlocking { dataStore.first() }`" - and a raw scan would fire
            // on the note explaining the fix, which is the failure mode where a
            // guard trips on the documentation written about it.
            val code = src
                .replace(Regex("/\\*[\\s\\S]*?\\*/"), "")
                .lines()
                .filterNot { it.trimStart().startsWith("//") }
                .joinToString("\n")
            code.contains("runBlocking")
        }
        assertEquals(
            "runBlocking is back on the startup path in $offenders. " +
                "Application.onCreate is non-suspending, so this is the shortest way to " +
                "read a stored value - and it puts a DataStore first-collection on the " +
                "critical path of every cold start. Resolve asynchronously and hold the " +
                "splash instead, the way AppLock.initialize does since US-2900.",
            emptyList<String>(),
            offenders,
        )
    }

    @Test
    fun `the guard would notice runBlocking outside a comment`() {
        // Proves the comment-stripping did not disarm the scan entirely. The
        // repo has an entry for exactly this: a case asserting a guard ignores
        // comments passed because the stripper was a no-op.
        val sample = """
            // runBlocking { x } in a line comment
            /* runBlocking { y } in a block comment */
            fun f() { runBlocking { z } }
        """.trimIndent()
        val stripped = sample
            .replace(Regex("/\\*[\\s\\S]*?\\*/"), "")
            .lines()
            .filterNot { it.trimStart().startsWith("//") }
            .joinToString("\n")
        assertTrue("the stripper removed the real call too", stripped.contains("runBlocking"))
        assertEquals(1, Regex("runBlocking").findAll(stripped).count())
    }

    @Test
    fun `AppLock resolves asynchronously and exposes whether it has`() {
        // The mechanism AC3 asks for: the first frame must not render unlocked
        // before the mode is known, and that is now kept by WAITING rather than
        // by blocking. If `resolved` disappears, the splash-hold condition in
        // MainActivity silently stops holding.
        val lock = source("platform/applock/AppLock.kt")!!
        assertTrue("AppLock lost its resolved flag", lock.contains("val resolved"))
        assertTrue(
            "AppLock.initialize should take a scope, not block",
            lock.contains("fun initialize(context: Context, scope: CoroutineScope)"),
        )

        val main = source("MainActivity.kt")!!
        assertTrue(
            "the splash no longer waits for the lock mode, so the shell can render unlocked",
            main.contains("AppLock.resolved.value"),
        )
    }
}
