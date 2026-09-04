package com.gradethread.app.ui.theme

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * US-3010: every site that paints a status emerald or amber resolves it through
 * [statusEmerald] / [statusAmber], EXCEPT the ones named below with a reason.
 *
 * ⚠ THIS EXISTS BECAUSE THE COUNT WAS PROSE. BrandLiteralTest's header said
 * "SEVENTEEN OTHER SITES DO NOT YET, and eight of those hold the raw hex" and
 * nothing checked it, so the number could only ever be right on the day it was
 * typed. A comment that records a count is a comment that goes stale; this
 * asserts it instead, so moving a site is a green run and adding one is a red.
 *
 * THE ALLOWLIST CAN ONLY SHRINK. Every entry must still match, so deleting a
 * legitimate exception fails just as loudly as adding an unreviewed one - the
 * failure names which half broke.
 *
 * ⚠ NOT EVERY REMAINING SITE IS A DEFECT, which is the whole reason this is an
 * allowlist with reasons rather than a count trending to zero. Two of the three
 * exceptions MUST NOT become theme-aware; making them so would be a regression
 * that a naive "finish the migration" pass would introduce while believing it
 * was completing this work.
 */
class StatusColorAdoptionTest {

    private val mainRoot = File("src/main/java/com/gradethread/app")

    /** The literals that mean "status emerald" or "status amber". */
    private val statusLiterals = listOf(
        "0xFF10B981", // emerald
        "0xFFF59E0B", // amber
        "BrandPalette.Emerald",
        "BrandPalette.Amber",
    )

    /**
     * Path suffix to the reason it is exempt. Each MUST still match something.
     *
     * The palette itself and the resolver are excluded by directory, not here:
     * ui/theme is where these values are DEFINED.
     */
    private val allowed = mapOf(
        "disclosure/DisclosureGeometry.kt" to
            "painted into an exported bitmap buyers open, so it must match the " +
            "web's SEVERITY_COLOR rather than the reader's theme",
        "measure/MeasurementPhotoEditorSheet.kt" to
            "drawn over the seller's photograph behind a white halo, not over an " +
            "app surface, so a dark-theme variant solves for a background that " +
            "is never there",
        "ui/components/StatusBadge.kt" to
            "StatusStyle.tone is pure and unit-tested; making it @Composable " +
            "costs that purity and needs the colour hoisted to each caller",
    )

    private fun sourcesUsingStatusLiterals(): Set<String> = mainRoot.walkTopDown()
        .filter { it.isFile && it.extension == "kt" }
        .filterNot { it.path.replace('\\', '/').contains("/ui/theme/") }
        .filter { file ->
            val body = stripComments(file.readText())
            statusLiterals.any { body.contains(it) }
        }
        .map { it.path.replace('\\', '/').substringAfter("com/gradethread/app/") }
        .toSet()

    /**
     * Comments are stripped so a KDoc EXPLAINING an exemption does not itself
     * read as one - both files annotated in US-3010 name the token in prose.
     */
    private fun stripComments(source: String): String = source
        .replace(Regex("""/\*.*?\*/""", RegexOption.DOT_MATCHES_ALL), "")
        .replace(Regex("""//.*"""), "")

    @Test
    fun `no unreviewed site paints a status colour that ignores the theme`() {
        val offenders = sourcesUsingStatusLiterals() - allowed.keys
        assertEquals(
            "These paint a status emerald or amber that cannot follow the theme " +
                "or the reader's contrast setting. Call statusEmerald() / " +
                "statusAmber() from ui/theme/StatusColor.kt instead, or add the " +
                "file here with the reason it must stay fixed.",
            emptySet<String>(),
            offenders,
        )
    }

    @Test
    fun `every exemption still applies`() {
        val actual = sourcesUsingStatusLiterals()
        val stale = allowed.keys - actual
        assertEquals(
            "These are listed as exempt but no longer paint a status colour at " +
                "all. Delete the entry - a stale exemption hides the next real one.",
            emptySet<String>(),
            stale,
        )
    }

    /**
     * The two exemptions that are CORRECT, pinned by name.
     *
     * Without this, a later pass "finishing the migration" would move them,
     * both tests above would stay green, and the regression would ship: an
     * exported disclosure image whose colours depend on who rendered it, and
     * a measurement line tinted for a surface it is never drawn on.
     */
    @Test
    fun `the two must-not-move exemptions are still exempt`() {
        for (path in listOf(
            "disclosure/DisclosureGeometry.kt",
            "measure/MeasurementPhotoEditorSheet.kt",
        )) {
            assertEquals(
                "$path must keep a fixed status colour: ${allowed[path]}",
                true,
                path in allowed.keys && path in sourcesUsingStatusLiterals(),
            )
        }
    }
}
