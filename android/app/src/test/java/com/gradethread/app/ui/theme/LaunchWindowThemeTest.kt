package com.gradethread.app.ui.theme

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * US-2899: what the seller looks at between the launcher tap and the first
 * Compose frame.
 *
 * THE DEFECT. `res/values/themes.xml` was three lines and extended
 * `android:Theme.Material.Light.NoActionBar`, with no `values-night` anywhere
 * in the project. The window background was therefore white on every device in
 * every system theme, from the moment the launcher started the activity until
 * Compose committed. On a phone in dark mode that is a full-screen white flash
 * in front of a dark app.
 *
 * IT COMPOUNDED WITH THE AUTH GATE. `MainActivity` renders
 * `Phase.Loading -> Unit` on purpose, so a sign-in form does not appear and
 * vanish on every cold start (US-2369). That is right about the flash and left
 * a hole: for as long as the session took to restore, the app showed an empty
 * white window with nothing on it at all.
 *
 * WHY A SOURCE SCAN. Neither half is reachable from a JVM test. A window
 * background is painted by the system before any of this app's code runs, and
 * `keepOnScreenCondition` is a platform callback — so a unit test can only ask
 * whether the wiring is present, which is precisely the question that was
 * wrong. The looking-at-it half is AC5 and needs a device. Same guard shape as
 * `DeleteReconcilerWiringTest` and `CameraCaptureProcessedTest`.
 */
class LaunchWindowThemeTest {

    /** Source with comments stripped: a header describing a deleted call must not pass. */
    private fun source(path: String): String = File(path).readText()
        .replace(Regex("""<!--[\s\S]*?-->"""), "")
        .replace(Regex("""/\*[\s\S]*?\*/"""), "")
        .replace(Regex("""(?m)^\s*//.*$"""), "")

    private val lightThemes by lazy { source("src/main/res/values/themes.xml") }
    private val nightThemes by lazy { source("src/main/res/values-night/themes.xml") }
    private val lightColors by lazy { source("src/main/res/values/colors.xml") }
    private val nightColors by lazy { source("src/main/res/values-night/colors.xml") }
    private val manifest by lazy { source("src/main/AndroidManifest.xml") }
    private val mainActivity by lazy {
        source("src/main/java/com/gradethread/app/MainActivity.kt")
    }
    private val composeTheme by lazy {
        source("src/main/java/com/gradethread/app/ui/theme/Theme.kt")
    }

    private fun colorValue(xml: String, name: String): String {
        val match = Regex("""<color name="$name">(#[0-9A-Fa-f]{6,8})</color>""").find(xml)
        assertTrue("no <color name=\"$name\"> in that resource file", match != null)
        return match!!.groupValues[1].uppercase()
    }

    // ── AC1: the window background follows the system theme ──────────────────

    @Test
    fun `both configurations set an explicit window background`() {
        listOf("values" to lightThemes, "values-night" to nightThemes).forEach { (dir, xml) ->
            assertTrue(
                "$dir/themes.xml must set android:windowBackground — the platform " +
                    "default is white and it is what the launcher paints",
                xml.contains("""<item name="android:windowBackground">@color/window_background</item>"""),
            )
        }
    }

    @Test
    fun `the night theme does not inherit a Light platform parent`() {
        assertTrue(
            "values/themes.xml should still extend a Light parent",
            lightThemes.contains("android:Theme.Material.Light.NoActionBar"),
        )
        // The background alone did not need values-night — @color resolves per
        // configuration. The PARENT did: a Light platform theme in dark mode
        // also sets light defaults for every surface Compose does not draw
        // (platform dialogs, selection handles, autofill, windowLightStatusBar).
        assertTrue(
            "values-night/themes.xml must override the parent, not just the colour",
            nightThemes.contains("""parent="android:Theme.Material.NoActionBar""""),
        )
        assertTrue(
            "the night theme must not extend a Light parent",
            !nightThemes.contains("Theme.Material.Light"),
        )
    }

    /**
     * The one that would rot silently.
     *
     * If these drift, nothing fails and nothing looks broken in a screenshot —
     * the first Compose frame simply changes colour under the seller, which
     * reads as a flicker rather than as a mismatched constant.
     */
    @Test
    fun `the window background matches the Compose scheme in both modes`() {
        assertEquals(
            "values/colors.xml window_background must equal LightColors.background " +
                "(BrandPalette.SoftGray)",
            "#F5F5F5",
            colorValue(lightColors, "window_background"),
        )
        assertEquals(
            "values-night/colors.xml window_background must equal DarkColors.background " +
                "(BrandPalette.Night)",
            "#1A1A2E",
            colorValue(nightColors, "window_background"),
        )
        // …and that those two names still mean those two values.
        assertTrue(
            "LightColors.background is no longer BrandPalette.SoftGray — update both colors.xml",
            composeTheme.contains("background = BrandPalette.SoftGray"),
        )
        assertTrue(
            "DarkColors.background is no longer BrandPalette.Night — update both colors.xml",
            composeTheme.contains("background = BrandPalette.Night"),
        )
        val palette = source("src/main/java/com/gradethread/app/ui/theme/BrandPalette.kt")
        assertTrue("SoftGray moved off #F5F5F5", palette.contains("SoftGray = Color(0xFFF5F5F5)"))
        assertTrue("Night moved off #1A1A2E", palette.contains("Night = Color(0xFF1A1A2E)"))
    }

    // ── AC2: the platform splash screen is wired ─────────────────────────────

    @Test
    fun `the splash theme exists and hands back to the app theme`() {
        assertTrue(
            "Theme.GradeThread.Splash must extend Theme.SplashScreen (the core-splashscreen backport)",
            lightThemes.contains("""<style name="Theme.GradeThread.Splash" parent="Theme.SplashScreen">"""),
        )
        assertTrue(
            "postSplashScreenTheme must return the activity to Theme.GradeThread, " +
                "or the splash style becomes a second app theme",
            lightThemes.contains("""<item name="postSplashScreenTheme">@style/Theme.GradeThread</item>"""),
        )
        assertTrue(
            "the splash background must be the same per-configuration colour as the window",
            lightThemes.contains("""<item name="windowSplashScreenBackground">@color/window_background</item>"""),
        )
    }

    /**
     * The icon is the ADAPTIVE icon, not its foreground layer.
     *
     * `drawable/ic_launcher_foreground` is a white mark. On the light splash
     * background (#F5F5F5) it would be invisible. `@mipmap/ic_launcher` carries
     * its own navy circle, so one reference is legible under both palettes.
     */
    @Test
    fun `the splash icon is legible on both backgrounds`() {
        assertTrue(
            "windowSplashScreenAnimatedIcon must be @mipmap/ic_launcher — the bare " +
                "foreground is a white mark and vanishes on the light background",
            lightThemes.contains(
                """<item name="windowSplashScreenAnimatedIcon">@mipmap/ic_launcher</item>""",
            ),
        )
    }

    @Test
    fun `only the launcher activity carries the splash theme`() {
        val splashUses = Regex("""@style/Theme\.GradeThread\.Splash""").findAll(manifest).count()
        assertEquals(
            "exactly one activity may launch on the splash theme. The others are " +
                "entered from a share sheet, an OAuth return or a widget tap — already " +
                "inside a visible app, where a launch logo is an interruption",
            1,
            splashUses,
        )
        val mainBlock = manifest.substringAfter(""".MainActivity""").substringBefore("</activity>")
        assertTrue(
            "MainActivity is the activity that must carry it",
            mainBlock.contains("@style/Theme.GradeThread.Splash"),
        )
    }

    @Test
    fun `the splash dependency is declared`() {
        val catalog = File("../gradle/libs.versions.toml").readText()
        assertTrue(
            "androidx.core:core-splashscreen must be in the version catalog",
            catalog.contains("""name = "core-splashscreen""""),
        )
        assertTrue(
            "…and actually depended on",
            source("build.gradle.kts").contains("implementation(libs.androidx.core.splashscreen)"),
        )
    }

    // ── AC3/AC4: what holds the splash, and what lets it go ──────────────────

    @Test
    fun `installSplashScreen runs before super onCreate`() {
        val install = mainActivity.indexOf("installSplashScreen()")
        val superCall = mainActivity.indexOf("super.onCreate(savedInstanceState)")
        assertTrue("MainActivity must call installSplashScreen()", install > -1)
        assertTrue(
            "installSplashScreen() must come BEFORE super.onCreate — the library " +
                "swaps the window theme there and it has to happen before the content view",
            install < superCall,
        )
    }

    @Test
    fun `the splash is held until the auth phase resolves`() {
        val condition = mainActivity.substringAfter("setKeepOnScreenCondition {")
            .substringBefore("}")
        assertTrue(
            "MainActivity must set a keepOnScreenCondition — otherwise the splash " +
                "dismisses immediately and Phase.Loading is a blank window again",
            mainActivity.contains("setKeepOnScreenCondition {"),
        )
        assertTrue(
            "the condition must read the auth phase",
            condition.contains("authRepository.phase.value is AuthRepository.Phase.Loading"),
        )
    }

    /**
     * AC4 — the bound, and the reason it is not enough on its own.
     *
     * Letting the splash go while `Phase.Loading` still renders `Unit` would
     * trade a logo for a blank window, which is the defect this story started
     * from. So the Loading branch has to change too, and both have to be driven
     * by the same clock or they can disagree about when the app gave up.
     */
    @Test
    fun `a stuck restore cannot leave the seller on the logo forever`() {
        assertTrue(
            "the keepOnScreenCondition needs a time bound",
            mainActivity.contains("SPLASH_MAX_HOLD_MS"),
        )
        assertTrue(
            "the bound must be measured on elapsedRealtime, not wall clock — a " +
                "clock change during launch must not extend or end the hold",
            mainActivity.contains("SystemClock.elapsedRealtime() - launchedAt < SPLASH_MAX_HOLD_MS"),
        )
        assertTrue(
            "past the bound, Phase.Loading must render the sign-in screen rather " +
                "than Unit — a dismissed splash over a blank window is the original bug",
            mainActivity.contains("if (restoreGaveUp) AuthScreen() else Unit"),
        )
        val effect = mainActivity.substringAfter("LaunchedEffect(Unit) {").substringBefore("}")
        assertTrue(
            "the give-up timer must be derived from the same launchedAt clock as the " +
                "splash condition, or the two escapes drift apart",
            effect.contains("SPLASH_MAX_HOLD_MS - (SystemClock.elapsedRealtime() - launchedAt)"),
        )
    }

    // ── AC6: a launch that starts locked ─────────────────────────────────────

    @Test
    fun `a locked launch is not held behind the splash`() {
        val condition = mainActivity.substringAfter("setKeepOnScreenCondition {")
            .substringBefore("}")
        assertTrue(
            "the condition must let go when the app launches locked. AppLock.initialize " +
                "already ran blocking in Application.onCreate, so the lock screen can draw " +
                "at once; holding for the session restore would delay it behind the logo",
            condition.contains("!AppLock.locked.value"),
        )
        val setContent = mainActivity.substringAfter("setContent {")
        assertTrue(
            "the lock must still be checked before the auth phase, so the shell never " +
                "flashes behind the lock screen",
            setContent.indexOf("if (locked)") < setContent.indexOf("when (authPhase)"),
        )
    }
}
