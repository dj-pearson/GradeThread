package com.gradethread.app.home

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * US-2907: US-1370 AC2 names four home quick actions. For a long time two of
 * them were missing and a comment explained why.
 *
 * THE SHAPE, which is the reason this file exists rather than a one-line diff.
 * The comment was right when it was written: Scout and Prospect had nowhere to
 * go, and "a button that opens a placeholder is worse than no button". US-1374
 * then landed, `scout/` became a real module, both screens were routed in
 * AppShell — and nobody came back to the comment. So the story read as closed,
 * the gap read as deliberate, and the explanation was false. That is worse than
 * the honest gap it described, because a documented gap stops being looked at.
 *
 * `check-android-orphans.mjs` could not have caught it: both screens were
 * mentioned plenty, being routed. Unreachable-from-anywhere is what that script
 * asks; unreachable-from-the-home-screen is a different question and this is it.
 *
 * A source scan because the alternative is a Compose UI test, and the app has no
 * testTag calls anywhere (US-2902 AC4) — such a test would be written against
 * display strings, which the localization work is still moving.
 */
class HomeQuickActionsTest {

    /**
     * Source with comments stripped: a header naming a deleted call cannot pass.
     *
     * THE CRLF NORMALISE GOES FIRST, and it is not tidying. Without it every
     * `\n` written in a pattern below fails to match a CRLF checkout,
     * `substringBefore` silently returns the WHOLE remaining file, and a scoped
     * guard quietly becomes a whole-file one. That is exactly how the AppShell
     * assertion in this file passed against a deliberately broken
     * `onScout = { }` — it was matching the ToolsScreen wiring 250 lines below
     * the call it thought it was reading.
     */
    private fun source(path: String): String = File(path).readText()
        .replace("\r\n", "\n")
        .replace(Regex("""/\*[\s\S]*?\*/"""), "")
        .replace(Regex("""(?m)^\s*//.*$"""), "")

    /**
     * The argument list of one call, by balanced parentheses.
     *
     * A literal end-marker was what broke the first version of this file: it
     * encodes the caller's indentation, so a reformat or one more nested lambda
     * moves it and the scope silently widens to everything after the call.
     * Counting brackets cannot drift that way.
     */
    private fun argsOf(haystack: String, callee: String): String {
        val open = haystack.indexOf(callee)
        assertTrue("call site is gone or was renamed: $callee", open > -1)
        var depth = 0
        var i = open + callee.length - 1
        val start = i + 1
        while (i < haystack.length) {
            when (haystack[i]) {
                '(' -> depth++
                ')' -> {
                    depth--
                    if (depth == 0) return haystack.substring(start, i)
                }
            }
            i++
        }
        throw AssertionError("unbalanced parentheses after $callee")
    }

    private val home by lazy {
        source("src/main/java/com/gradethread/app/home/HomeScreen.kt")
    }
    private val shell by lazy {
        source("src/main/java/com/gradethread/app/ui/shell/AppShell.kt")
    }

    /** The quick-actions block alone — the file also renders the checklist. */
    private val quickActions by lazy {
        val start = home.indexOf("R.string.home_quick_actions")
        assertTrue("the quick-actions block is gone or was renamed", start > -1)
        val end = home.indexOf("R.string.home_certified_grades", start)
        assertTrue("the end of the quick-actions block moved — rescope this guard", end > start)
        home.substring(start, end)
    }

    @Test
    fun `all four actions US-1370 AC2 names are offered`() {
        listOf(
            "R.string.home_add_item",
            "R.string.home_snap_to_value",
            "R.string.tools_scout",
            "R.string.tools_prospect",
        ).forEach {
            assertTrue("home quick actions must include $it", quickActions.contains(it))
        }
    }

    @Test
    fun `each action calls its own handler`() {
        listOf("onAddItem()", "onSnap()", "onScout()", "onProspect()").forEach {
            assertTrue("the $it quick action is not wired to anything", quickActions.contains(it))
        }
    }

    /**
     * The half a source scan can still get wrong: a parameter that exists and is
     * passed `{}` at the call site looks identical to a wired one from inside
     * HomeScreen.kt.
     */
    @Test
    fun `AppShell navigates the two new actions to the real routes`() {
        val homeCall = argsOf(shell, "com.gradethread.app.home.HomeScreen(")
        assertTrue(
            "onScout must navigate to ShellRoutes.SCOUT",
            Regex("""onScout\s*=\s*\{[^}]*ShellRoutes\.SCOUT""").containsMatchIn(homeCall),
        )
        assertTrue(
            "onProspect must navigate to ShellRoutes.PROSPECT",
            Regex("""onProspect\s*=\s*\{[^}]*ShellRoutes\.PROSPECT""").containsMatchIn(homeCall),
        )
        assertTrue(
            "both routes must still be registered in the NavHost",
            shell.contains("composable(ShellRoutes.SCOUT)") &&
                shell.contains("composable(ShellRoutes.PROSPECT)"),
        )
    }

    /**
     * AC3, as far as a source scan can ask it: two rows of two, not one of four.
     *
     * At 320dp a quarter-width button wraps "Snap to Value" onto three lines,
     * and a horizontally scrolling row hides the fourth action behind a gesture
     * nothing signals.
     */
    @Test
    fun `the four actions are laid out as two rows, not crushed into one`() {
        val rows = Regex("""\bRow\(""").findAll(quickActions).count()
        assertEquals("expected exactly two Rows in the quick-actions block", 2, rows)
        assertTrue(
            "a scrolling row would hide the fourth action",
            !quickActions.contains("horizontalScroll") && !quickActions.contains("LazyRow"),
        )
        assertEquals(
            "every action should take an equal share of its row",
            4,
            Regex("""Modifier\.weight\(1f\)""").findAll(quickActions).count(),
        )
    }

    /**
     * The reason the story existed, generalised.
     *
     * A comment saying a story "hasn't landed" outlives the landing. Sweeping
     * for it found a SECOND one in this same file — the notifications checklist
     * row said push delivery was US-1378 and "isn't built yet" while
     * `platform/push` held nine working files. This pins both phrasings out of
     * the file rather than trusting a one-off sweep.
     */
    @Test
    fun `no comment in HomeScreen claims a shipped story has not landed`() {
        val withComments = File("src/main/java/com/gradethread/app/home/HomeScreen.kt")
            .readText()
            .replace("\r\n", "\n")
        listOf("US-1374 hasn't landed", "US-1378 and\n                            // isn't built yet")
            .forEach {
                assertTrue(
                    "a stale forward-reference is back in HomeScreen.kt: $it",
                    !withComments.contains(it),
                )
            }
    }
}
