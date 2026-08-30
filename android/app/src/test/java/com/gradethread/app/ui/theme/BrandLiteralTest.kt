package com.gradethread.app.ui.theme

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * US-3009: a brand colour outside the theme is a colour that cannot follow the
 * theme.
 *
 * THE TWO DEFECTS THIS COMES FROM, both found on 2026-08-29 and both invisible
 * in light mode, which is the mode people develop in:
 *
 *   US-3004  `Color(0xFF0F3460)` — brand NAVY — was the grade colour for the
 *            7.0-9.4 band, copied into FIVE screens. The dark surface is also
 *            navy, so on a dark phone the 8.5 at the top of a grade report was
 *            navy on navy. It is the number this product exists to produce.
 *
 *   US-3009  `Color(0xFFE94560)` — brand RED — was a status chip's text colour.
 *            That value is 3.83:1 against white, below AA, and the web forbids
 *            it as text outright (US-2334, src/test/red-text-contrast.test.ts).
 *
 * Both are the same mistake: a literal cannot vary by theme, and the brand
 * colours are exactly the ones whose light and dark values differ. The palette
 * has a token for each; a literal is a token that stopped working.
 *
 * ⚠ SEMANTIC LITERALS ARE DELIBERATELY NOT BANNED. Emerald, amber and the
 * neutral greys stay legal outside this package: they are mid-tone hues that
 * carry on both surfaces, and they mean something (good, warning, muted) rather
 * than meaning "ours". GradeColor.kt argues this at the point of use, and the
 * dark goldens back it - the amber capture was added specifically because that
 * claim had not been checked. Only the BRAND values are banned, because those
 * are the ones that collide with the brand surfaces.
 *
 * It starts green: the sweep behind US-3009 found exactly one offender in the
 * whole app and it is fixed.
 *
 * ⚠ THE BLIND SPOT, AND IT HAS ALREADY COST SOMETHING (US-3010).
 * This scan EXCLUDES ui/theme, and it has to - the palette is defined there, so
 * scanning it would fail on every token. But that is also the one directory
 * where colour decisions are made, and the exclusion is invisible in a green
 * result.
 *
 * GradeColor.kt sat inside it holding three raw literals. Two duplicated tokens
 * declared twenty lines away in BrandPalette (Emerald, Amber). The third was
 * #E94560 - the SURFACE red - returned as the colour of a FAILING GRADE, which
 * this function's callers draw as text at 3.83:1. That is precisely the defect
 * named at the top of this file, in the only place this file cannot look.
 *
 * So a green run here means "no brand literal OUTSIDE ui/theme", never "the
 * theme is correct". Anything added under ui/theme still needs reading.
 */
class BrandLiteralTest {

    private val mainRoot = File("src/main/java/com/gradethread/app")
    private val themeDir = File(mainRoot, "ui/theme")

    /**
     * The brand values, and the token to reach for instead.
     *
     * Kept as text rather than as Color objects on purpose: this test reads
     * SOURCE, so what it needs to match is what someone typed.
     */
    private val banned = mapOf(
        "0xFF0F3460" to "MaterialTheme.colorScheme.primary (BrandPalette.Navy is the LIGHT primary)",
        "0xFFE94560" to "MaterialTheme.colorScheme.error (BrandPalette.RedText for copy; Red is a fill)",
        "0xFF1A1A2E" to "MaterialTheme.colorScheme.background/surface (BrandPalette.Night)",
        "0xFFF5F5F5" to "MaterialTheme.colorScheme.surface (BrandPalette.SoftGray)",
        "0xFF3B82F6" to "MaterialTheme.colorScheme.primary (BrandPalette.NavyDark is the DARK primary)",
        "0xFFFB5E78" to "MaterialTheme.colorScheme.error (BrandPalette.RedDark is the DARK error)",
    )

    private fun sources(): List<File> = mainRoot.walkTopDown()
        .filter { it.isFile && it.extension == "kt" }
        .filterNot { it.absolutePath.startsWith(themeDir.absolutePath) }
        .toList()

    @Test
    fun `no brand colour literal outside the theme package`() {
        val offenders = mutableListOf<String>()
        for (file in sources()) {
            val text = file.readText()
            for ((hex, instead) in banned) {
                if (text.contains(hex, ignoreCase = true)) {
                    offenders += "${file.path} uses $hex — use $instead"
                }
            }
        }
        assertEquals(
            "A brand colour literal cannot follow the theme, and the brand colours " +
                "are the ones whose light and dark values differ. Navy on the Night " +
                "surface is navy on navy (US-3004); red at 3.83:1 is below AA as text " +
                "(US-3009). Use the scheme role:\n" + offenders.joinToString("\n"),
            emptyList<String>(),
            offenders,
        )
    }

    @Test
    fun `the guard can still see a literal, and still finds the sources`() {
        // Mode 6 of the repo's guards-that-do-not-guard list: a scan that walks
        // nothing passes exactly like a clean tree. Both halves are checked -
        // that files are found at all, and that the pattern still matches the
        // shape it bans.
        val files = sources()
        assertTrue("the scan found no Kotlin sources at all — the root moved", files.size > 50)

        val sabotage = """
            val tone = Color(0xFF0F3460)
        """.trimIndent()
        assertTrue(
            "the banned-literal pattern stopped matching its own example",
            banned.keys.any { sabotage.contains(it, ignoreCase = true) },
        )

        // And the theme package itself is excluded, or every token would fail.
        assertTrue(
            "BrandPalette.kt is inside the scan, so the palette would fail its own rule",
            files.none { it.name == "BrandPalette.kt" },
        )
    }
}
