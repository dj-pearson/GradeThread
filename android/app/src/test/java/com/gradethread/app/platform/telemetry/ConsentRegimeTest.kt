package com.gradethread.app.platform.telemetry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * US-2897: the consent regime, and its parity with the web.
 *
 * The cases below mirror `src/lib/consent-regime.test.ts` deliberately and
 * one for one. This is a PORT of a decision already made, so the way it fails
 * should be "Android and the web disagree", not "Android has a bug" — and the
 * only way to get that is to assert the same inputs.
 *
 * WHAT THE STORY GOT WRONG, recorded because it changed the work: it claimed
 * Android defaulted analytics ON while iOS asked first. iOS does not ask first
 * — `Telemetry.swift` reads `object(forKey:) ?? true` and its own comment says
 * "Opt-out, on by default". Both phones behaved the same. The gap was between
 * MOBILE and WEB.
 */
class ConsentRegimeTest {

    private fun geo(country: String?, isEU: Boolean = false, region: String? = null) =
        GeoSignal(country = country, regionCode = region, isEU = isEU)

    // ── parity with consent-regime.ts ────────────────────────────────────────

    @Test
    fun `treats the US as opt-out (CCPA notice)`() {
        assertEquals(ConsentRegime.OPT_OUT, Consent.regimeFor(geo("US")))
        assertEquals(ConsentRegime.OPT_OUT, Consent.regimeFor(geo("US", region = "CA")))
    }

    @Test
    fun `treats EU countries as opt-in (GDPR)`() {
        assertEquals(ConsentRegime.OPT_IN, Consent.regimeFor(geo("DE", isEU = true)))
        assertEquals(ConsentRegime.OPT_IN, Consent.regimeFor(geo("FR", isEU = true)))
    }

    @Test
    fun `treats the UK and Switzerland as opt-in`() {
        assertEquals(ConsentRegime.OPT_IN, Consent.regimeFor(geo("GB")))
        assertEquals(ConsentRegime.OPT_IN, Consent.regimeFor(geo("CH")))
    }

    @Test
    fun `treats rest-of-world as opt-in by default`() {
        assertEquals(ConsentRegime.OPT_IN, Consent.regimeFor(geo("BR")))
        assertEquals(ConsentRegime.OPT_IN, Consent.regimeFor(geo("AU")))
    }

    @Test
    fun `fails safe to opt-in when geo is unknown`() {
        // The three ways "we do not know" arrives: no signal at all (the fetch
        // has not finished), the explicit unknown, and a signal with no country.
        assertEquals(ConsentRegime.OPT_IN, Consent.regimeFor(null))
        assertEquals(ConsentRegime.OPT_IN, Consent.regimeFor(GeoSignal.UNKNOWN))
        assertEquals(ConsentRegime.OPT_IN, Consent.regimeFor(geo(null)))
        assertEquals(ConsentRegime.OPT_IN, Consent.regimeFor(geo("")))
        assertEquals(ConsentRegime.OPT_IN, Consent.regimeFor(geo("   ")))
    }

    @Test
    fun `country matching is case-insensitive`() {
        // The endpoint uppercases, but a lowercase value must not silently
        // become opt-in — that would be the strict answer for the wrong reason,
        // and it would hide the bug rather than fail on it.
        assertEquals(ConsentRegime.OPT_OUT, Consent.regimeFor(geo("us")))
    }

    // ── the tri-state, which is the actual mechanism ─────────────────────────

    @Test
    fun `an unasked seller follows the regime`() {
        // null = never asked. This is the case that used to be hard-coded on.
        assertFalse(Consent.analyticsAllowed(ConsentRegime.OPT_IN, null))
        assertTrue(Consent.analyticsAllowed(ConsentRegime.OPT_OUT, null))
    }

    @Test
    fun `an explicit no is honoured in an opt-out jurisdiction`() {
        // The important asymmetry. Living somewhere with an opt-out regime does
        // not un-say "no" — a seller who turned it off stays off in the US.
        assertFalse(Consent.analyticsAllowed(ConsentRegime.OPT_OUT, false))
    }

    @Test
    fun `an explicit yes is honoured in an opt-in jurisdiction`() {
        // The mirror: consent given in the EU is consent, and must not be
        // overridden by the strict default.
        assertTrue(Consent.analyticsAllowed(ConsentRegime.OPT_IN, true))
    }

    @Test
    fun `a fresh install in the EU does not start analytics`() {
        // The whole point of the story, stated as one assertion.
        assertFalse(Consent.analyticsAllowed(Consent.regimeFor(geo("DE", isEU = true)), null))
    }

    @Test
    fun `a fresh install with no network does not start analytics`() {
        // Geo failed, so the seller could be anywhere — including the EU.
        assertFalse(Consent.analyticsAllowed(Consent.regimeFor(GeoSignal.UNKNOWN), null))
    }

    // ── the endpoint's placeholder countries ─────────────────────────────────

    @Test
    fun `Cloudflare placeholder countries read as unknown`() {
        // T1 is Tor and XX is unresolvable. The web maps both to null so the
        // strict default applies; a Tor exit node is exactly the visitor not to
        // guess about.
        assertNull(GeoService.normalizeCountry("T1"))
        assertNull(GeoService.normalizeCountry("XX"))
        assertNull(GeoService.normalizeCountry(null))
        assertNull(GeoService.normalizeCountry(""))
        assertNull(GeoService.normalizeCountry("  "))
        assertEquals("US", GeoService.normalizeCountry("us"))
        assertEquals("DE", GeoService.normalizeCountry(" de "))
    }

    // ── wiring, in the source-scanning idiom ─────────────────────────────────

    private fun body(path: String): String = File(path).readText()
        .replace(Regex("""/\*[\s\S]*?\*/"""), "")
        .replace(Regex("""(?m)^\s*//.*$"""), "")

    @Test
    fun `bootstrap no longer blocks the main thread`() {
        val telemetry = body("src/main/java/com/gradethread/app/platform/telemetry/Telemetry.kt")
        assertFalse(
            "Telemetry.bootstrap is doing a blocking DataStore read on the main thread again",
            telemetry.contains("runBlocking"),
        )
    }

    @Test
    fun `an absent stored choice reads as null, not as consent`() {
        // The single line the whole bug lived on. `?: false` here would restore
        // "never asked means yes".
        val telemetry = body("src/main/java/com/gradethread/app/platform/telemetry/Telemetry.kt")
        assertTrue(
            "storedChoice no longer maps an absent key to null",
            telemetry.contains("OPT_OUT_KEY]?.let { !it }"),
        )
    }

    @Test
    fun `bootstrap consults the regime rather than starting PostHog outright`() {
        val telemetry = body("src/main/java/com/gradethread/app/platform/telemetry/Telemetry.kt")
        val start = telemetry.indexOf("fun bootstrap(")
        assertTrue("bootstrap is gone or was renamed", start > -1)
        val end = telemetry.indexOf("\n    internal suspend fun storedChoice", start)
        assertTrue("storedChoice is gone or was renamed", end > -1)
        val fn = telemetry.substring(start, end)

        assertTrue("bootstrap no longer resolves a consent regime", fn.contains("Consent.regimeFor"))
        assertTrue("bootstrap no longer gates PostHog on consent", fn.contains("Consent.analyticsAllowed"))
        assertTrue("bootstrap no longer starts Sentry unconditionally", fn.contains("startSentry"))
    }

    @Test
    fun `geo is fetched from the Pages site, not the edge service`() {
        // functions.gradethread.com runs on Coolify behind no Cloudflare edge,
        // so request.cf does not exist there and the endpoint could only ever
        // answer "unknown". That fails SAFE, which is why it would never be
        // noticed — every seller silently treated as opt-in.
        val geo = body("src/main/java/com/gradethread/app/platform/telemetry/GeoService.kt")
        assertTrue(
            "the geo endpoint is no longer the Cloudflare Pages site",
            geo.contains("https://gradethread.com/geo.json"),
        )
        assertFalse(
            "geo is being fetched from the edge service, which has no Cloudflare geo",
            geo.contains("functions.gradethread.com"),
        )
    }

    @Test
    fun `the Settings toggle observes analytics rather than reading it once`() {
        val settings = body("src/main/java/com/gradethread/app/settings/SettingsViewModel.kt")
        assertTrue(
            "Settings reads analytics state once at construction again — it now resolves " +
                "asynchronously, so the toggle would render off and stay there",
            settings.contains("Telemetry.analyticsEnabledFlow.collect"),
        )
    }
}
