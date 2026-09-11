package com.gradethread.app.ui

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * US-3311: an indeterminate Material 3 progress indicator cannot be captured,
 * and the way it fails costs twenty minutes of a CI shard before it says so.
 *
 * ⚠ THE COST, MEASURED. `CircularProgressIndicator()` and
 * `LinearProgressIndicator()` hold a `rememberInfiniteTransition` that requests
 * another frame forever. `captureRoboImage` drains the Robolectric looper until
 * the composition goes idle, and that composition never does. On 2026-09-10,
 * thirteen goldens across twelve classes took 820 to 1202 seconds EACH - 93
 * percent of a 246-test-minute suite - and every one of them still failed,
 * because the pixels were the spinner at whatever angle the fork stopped on.
 * `BulkGradeScreenshotTest` alone was 40.1 minutes in a single Gradle fork,
 * which no amount of sharding can split.
 *
 * ⚠ WHY A SCAN AND NOT A REVIEW. Both halves of the fix are invisible at the
 * call site. A screen that swaps `BusySpinner()` back for
 * `CircularProgressIndicator()` looks identical to a user and to a reviewer;
 * a new screenshot test that wraps its own `GradeThreadTheme` looks like every
 * other test in the directory. The only symptom either produces is a shard that
 * runs long, which reads as a slow runner.
 *
 * ⚠ WHAT THIS DOES NOT CATCH. It reads text. A composable reached from a
 * third-party library, or one built by a `@Composable` variable, is invisible
 * to it, and so is an indicator added to `androidTest`. The two real failure
 * modes are both direct and textual, which is why a scan is worth having;
 * naming the limit here so a green run is not read as more than it is.
 */
class BusyIndicatorUsageTest {

    private val mainRoot = File("src/main/java/com/gradethread/app")
    private val screenshotTests = File("src/test/java/com/gradethread/app/ui")
        .listFiles { f -> f.name.endsWith("ScreenshotTest.kt") }
        ?.sortedBy { it.name }
        .orEmpty()

    private fun stripComments(text: String): String = text
        .replace(Regex("""/\*[\s\S]*?\*/"""), " ")
        .replace(Regex("""(?m)//.*$"""), " ")

    private fun stripImports(text: String): String = text.replace(Regex("""(?m)^import .*$"""), " ")

    private val mainSources: Map<File, String> by lazy {
        mainRoot.walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .associateWith { stripImports(stripComments(it.readText())) }
    }

    /**
     * An indeterminate call: the component name, an open paren, and no
     * `progress =` argument.
     *
     * ⚠ THE `progress` LOOKAHEAD IS THE WHOLE RULE. Seven determinate call
     * sites - the AI extract queue, the autolister batch, the drafts library,
     * the consumer grade upload, the passport strength meter, the plan-gate
     * warning and the verification checklist - show a real fraction, run no
     * animation, and already capture in milliseconds. Banning those too would
     * be a rename with no behaviour behind it.
     */
    private fun indeterminateCalls(text: String): List<String> =
        Regex("""(?<![\w.])(Circular|Linear)ProgressIndicator\((?!\s*\n?\s*progress\s*=)""")
            .findAll(text)
            .map { "${it.groupValues[1]}ProgressIndicator(" }
            .toList()

    @Test
    fun `the scan found the sources it is supposed to be watching`() {
        assertTrue("no main sources were read; the walk broke", mainSources.size > 100)
        assertTrue(
            "found ${screenshotTests.size} screenshot tests; the directory or the suffix changed",
            screenshotTests.size >= 50,
        )
    }

    /**
     * The regex has to still recognise an offence. Without this, a broken
     * pattern reports a clean codebase, which is exactly the shape of failure
     * that let thirteen unrenderable goldens sit in the suite for weeks.
     */
    @Test
    fun `the indeterminate pattern still matches and the determinate one still does not`() {
        assertTrue(
            "the scan stopped recognising an indeterminate call",
            indeterminateCalls("Row { CircularProgressIndicator() }").isNotEmpty(),
        )
        assertTrue(
            "the scan stopped recognising an indeterminate bar",
            indeterminateCalls("LinearProgressIndicator(Modifier.fillMaxWidth())").isNotEmpty(),
        )
        assertTrue(
            "the scan now objects to a determinate indicator, which is allowed",
            indeterminateCalls("LinearProgressIndicator(\n progress = { 0.5f },\n)").isEmpty(),
        )
    }

    @Test
    fun `app code reaches an indeterminate indicator only through BusySpinner or BusyBar`() {
        val offences = mainSources
            .filterKeys { it.name != "BusyIndicator.kt" }
            .flatMap { (file, text) -> indeterminateCalls(text).map { "${file.path}: $it" } }

        assertTrue(
            "An indeterminate Material 3 indicator never goes idle, so any golden " +
                "that reaches one hangs its Gradle fork until the job is killed. Call " +
                "BusySpinner() or BusyBar() instead - they are the same component, and " +
                "they freeze to a determinate stand-in when a screenshot test asks:\n" +
                offences.joinToString("\n"),
            offences.isEmpty(),
        )
    }

    @Test
    fun `every screenshot test captures under ScreenshotTheme`() {
        val offences = screenshotTests
            .filter { file ->
                Regex("""(?<![\w.])GradeThreadTheme[\s(]""")
                    .containsMatchIn(stripImports(stripComments(file.readText())))
            }
            .map { it.path }

        assertTrue(
            "A golden captured under GradeThreadTheme directly does not get " +
                "LocalProgressAnimation = false, so any spinner in it hangs the capture. " +
                "Use ScreenshotTheme, which is GradeThreadTheme plus that one line:\n" +
                offences.joinToString("\n"),
            offences.isEmpty(),
        )
    }

    /**
     * ScreenshotTheme is only worth enforcing while it still does the thing it
     * is enforced for. A refactor that drops the provider would leave every
     * assertion above passing over a wrapper that no longer freezes anything.
     */
    @Test
    fun `ScreenshotTheme still provides the frozen local`() {
        val helper = File("src/test/java/com/gradethread/app/ui/ScreenshotTheme.kt").readText()
        assertTrue(
            "ScreenshotTheme no longer provides LocalProgressAnimation = false",
            helper.contains("LocalProgressAnimation provides false"),
        )
    }
}
