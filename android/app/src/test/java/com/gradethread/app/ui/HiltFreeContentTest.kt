package com.gradethread.app.ui

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * US-2902 AC3: a `*Content` body that reaches a Hilt-backed composable cannot
 * be captured, and the failure does not look like one.
 *
 * ⚠ THIS HAS HAPPENED TWICE, both times invisibly.
 *
 *   MoneyContent gained `ReceiptScanButton()` in the expenses row (US-3000).
 *   ScoutContent had `TripQuickLogButton()` above the fold.
 *
 * Both resolve their own ViewModel through `hiltViewModel()`, and
 * RoborazziActivity is not a Hilt component, so any capture that composes one
 * dies on "Given component holder class ... does not implement
 * GeneratedComponentManager".
 *
 * ⚠ AND LAZYCOLUMN HIDES IT. It only composes what is on screen, so the Money
 * break took exactly two of nine captures - the two that empty the panels above
 * to lift equity into the viewport - plus the tablet one, which is wide enough
 * to reach the row outright. Seven captures stayed green over a body that could
 * not be rendered. A defect that takes a fraction of a suite reads as a flaky
 * fixture, not as a wiring error.
 *
 * ⚠ THE FIX IS A SLOT, NOT HOISTING. These composables are self-contained on
 * purpose - ReceiptScanButton owns its picker, its ViewModel and its form - so
 * pulling their state up would spread each one across every host screen. A slot
 * defaulting to the real composable keeps the wrapper honest and lets a test
 * pass a stateless stand-in.
 *
 * ⚠ WHAT THIS SCANS, AND WHAT IT CANNOT. It reads the BODY of each `fun
 * *Content(` and looks for a direct call to a self-contained composable. It
 * does NOT follow calls, so a Hilt-backed composable reached two levels down
 * still slips through. The two real defects were both direct calls; a
 * transitive one would need a call graph, which is a different tool. Named
 * here so a green run is not read as more than it is.
 */
class HiltFreeContentTest {

    private val root = File("src/main/java/com/gradethread/app")

    private fun stripComments(text: String): String = text
        .replace(Regex("""/\*[\s\S]*?\*/"""), " ")
        .replace(Regex("""(?m)//.*$"""), " ")

    private val sources: Map<File, String> by lazy {
        root.walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .associateWith { stripComments(it.readText()) }
    }

    /**
     * A composable that resolves its own ViewModel and is NOT a screen or a
     * host. Screens and hosts are the wrappers; these are the ones that get
     * dropped into somebody else's layout.
     */
    private val selfContained: Set<String> by lazy {
        sources.values.flatMap { text ->
            Regex("""fun\s+([A-Z]\w+)\s*\(""").findAll(text)
                .filter { paramsOf(text, text.indexOf('(', it.range.first)).contains("hiltViewModel()") }
                .map { it.groupValues[1] }
                .filterNot { it.endsWith("Screen") || it.endsWith("Host") }
        }.toSet()
    }

    /**
     * The parameter list, balanced.
     *
     * ⚠ A NAIVE `[^)]*` DOES NOT WORK HERE and the first draft of this file
     * shipped with it: `viewModel: X = hiltViewModel()` closes the group on the
     * paren INSIDE hiltViewModel, so the marker this scan looks for never
     * appeared in what it read. Discovery came back empty and every assertion
     * below passed over nothing - the exact false green the sanity case exists
     * to catch, caught on the first run.
     */
    private fun paramsOf(text: String, open: Int): String {
        if (open < 0) return ""
        var depth = 0
        for (i in open until text.length) {
            when (text[i]) {
                '(' -> depth++
                ')' -> {
                    depth--
                    if (depth == 0) return text.substring(open, i)
                }
            }
        }
        return ""
    }

    /**
     * The body of a function, from its opening brace to the matching close.
     *
     * ⚠ IT STARTS AFTER THE PARAMETER LIST, and skipping that step is how the
     * first run of this file reported both slots as offences. `MoneyContent`'s
     * parameters END with `receiptScan: @Composable () -> Unit = {
     * ReceiptScanButton() }`, so the first `{` after the function name belongs
     * to that DEFAULT, not to the body - and the scan then read the default it
     * is supposed to permit as the call it is supposed to ban. A guard that
     * fires on the fix is worse than one that misses the bug.
     */
    private fun bodyAt(text: String, signatureStart: Int): String {
        // paramsOf() returns a substring starting AT the paren, so the offset
        // is measured from the paren - not from the `fun` keyword. Adding it to
        // signatureStart lands short by the length of "fun SomeName", which
        // happened to still clear the default lambda and would have stopped
        // doing so the moment a parameter list got shorter.
        val paramsOpen = text.indexOf('(', signatureStart)
        val paramsEnd = paramsOpen + paramsOf(text, paramsOpen).length
        val open = text.indexOf('{', paramsEnd)
        if (open < 0) return ""
        var depth = 0
        for (i in open until text.length) {
            when (text[i]) {
                '{' -> depth++
                '}' -> {
                    depth--
                    if (depth == 0) return text.substring(open, i)
                }
            }
        }
        return text.substring(open)
    }

    private data class Body(val file: File, val name: String, val text: String)

    private val contentBodies: List<Body> by lazy {
        sources.flatMap { (file, text) ->
            Regex("""fun\s+(\w+Content)\s*\(""").findAll(text).map { match ->
                Body(file, match.groupValues[1], bodyAt(text, match.range.first))
            }
        }
    }

    @Test
    fun `the scan found the composables it is supposed to be watching`() {
        // If the discovery regex breaks, every assertion below passes over an
        // empty set. These two are the known offenders and must stay found.
        assertTrue(
            "discovery found no self-contained Hilt composables at all: $selfContained",
            selfContained.size >= 2,
        )
        assertTrue("ReceiptScanButton is no longer discovered", "ReceiptScanButton" in selfContained)
        assertTrue("TripQuickLogButton is no longer discovered", "TripQuickLogButton" in selfContained)
    }

    @Test
    fun `the scan found some Content bodies to check`() {
        assertTrue("no *Content composables were found; the regex broke", contentBodies.size >= 10)
    }

    @Test
    fun `no Content body calls a composable that resolves its own ViewModel`() {
        val offences = contentBodies.flatMap { body ->
            selfContained
                .filter { name -> Regex("""(?<![\w.])$name\s*\(""").containsMatchIn(body.text) }
                .map { name -> "${body.file.path}: ${body.name} calls $name()" }
        }

        assertTrue(
            "A *Content body must stay renderable without a Hilt graph, or no " +
                "screenshot test can capture it. Take the composable as a slot " +
                "parameter defaulting to the real one, the way MoneyContent " +
                "takes receiptScan and ScoutContent takes tripQuickLog:\n" +
                offences.joinToString("\n"),
            offences.isEmpty(),
        )
    }

    /**
     * The slot DEFAULT is allowed to name the real composable - that is the
     * point of the pattern - so this proves the two known slots still do, and
     * that the exemption is a default rather than a call in the body.
     */
    @Test
    fun `the known slots still default to the real composable`() {
        val money = sources.getValue(File(root, "money/MoneyScreen.kt"))
        assertTrue(
            "MoneyContent's receiptScan slot no longer defaults to the real button",
            money.contains("receiptScan: @Composable () -> Unit = { ReceiptScanButton() }"),
        )
        val scout = sources.getValue(File(root, "scout/ScoutScreen.kt"))
        assertTrue(
            "ScoutContent's tripQuickLog slot no longer defaults to the real button",
            scout.contains("tripQuickLog: @Composable () -> Unit = { TripQuickLogButton() }"),
        )
    }
}
