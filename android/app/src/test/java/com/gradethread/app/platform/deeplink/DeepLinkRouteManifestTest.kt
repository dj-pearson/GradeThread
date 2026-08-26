package com.gradethread.app.platform.deeplink

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * US-2898: the manifest and [DeepLinkRoute] must agree.
 *
 * They are two hand-maintained lists, in two files, in two languages, and they
 * had already fallen out of step: `DeepLinkRoute.fromAppLink` had parsed
 * `/app/shipping` since US-1377 and the manifest never claimed it, so Android
 * never delivered the intent — the link opened a browser and the seller landed
 * on the website. The custom-scheme route to the same screen
 * (`com.gradethread.app://widget/shipping`) worked, because the widget host IS
 * claimed. One of the two paths to the shipping queue worked and the other
 * silently did not, which is the worst version of this bug: nothing errors, it
 * just goes somewhere else.
 *
 * `check-merged-manifest.mjs` could not see it. That guard verifies four
 * system-reachable COMPONENTS survive the merge and says nothing about which
 * paths those components claim.
 *
 * BOTH DIRECTIONS ARE CHECKED, and the second is not decoration:
 *  - a route with no prefix is dead (the bug above);
 *  - a prefix with no route sends the seller into the app and then nowhere,
 *    which is worse than the browser, because the app is now showing them a
 *    screen they did not ask for with no way back to what they tapped.
 */
class DeepLinkRouteManifestTest {

    private fun read(path: String): String = File(path).readText()

    /** Comments stripped: a path named only in prose is a path nothing routes. */
    private fun stripKotlin(s: String): String = s
        .replace(Regex("""/\*[\s\S]*?\*/"""), "")
        .replace(Regex("""(?m)^\s*//.*$"""), "")

    private fun stripXml(s: String): String = s.replace(Regex("""<!--[\s\S]*?-->"""), "")

    private val manifest by lazy {
        stripXml(read("src/main/AndroidManifest.xml"))
    }
    private val route by lazy {
        stripKotlin(read("src/main/java/com/gradethread/app/platform/deeplink/DeepLinkRoute.kt"))
    }

    /**
     * The body of one `when` block, by the function that owns it.
     *
     * Scoped rather than whole-file for the reason DeleteReconcilerWiringTest's
     * header spells out: a whole-file scan cannot tell one grammar from
     * another, and this file holds three (app link, widget, shortcut) whose
     * segment names overlap — "money" and "capture" appear in two of them.
     */
    private fun whenBodyOf(fn: String): String {
        val start = route.indexOf(fn)
        assertTrue("$fn is gone or was renamed", start > -1)
        val end = route.indexOf("\n        }", start).let { if (it > -1) it else route.length }
        return route.substring(start, end)
    }

    /** `"segment" ->` cases, minus the ones that deliberately resolve to null. */
    private fun segmentsOf(fn: String): Set<String> = Regex(""""([a-z-]+)"\s*->""").findAll(whenBodyOf(fn))
        .map { it.groupValues[1] }
        .filter { segment ->
            // A case whose whole body is `null` is a deliberate REFUSAL, not
            // a destination — /app/auth-callback is AuthCallbackActivity's.
            !Regex(""""$segment"\s*->\s*null""").containsMatchIn(whenBodyOf(fn))
        }
        .toSet()

    private val manifestAppLinkPrefixes: Set<String> by lazy {
        Regex("""pathPrefix="/app/([a-z/-]+)"""").findAll(manifest)
            .map { it.groupValues[1] }
            .toSet()
    }

    @Test
    fun `every app-link route the app parses is claimed in the manifest`() {
        val parsed = segmentsOf("private fun fromAppLink(")
        val unclaimed = parsed - manifestAppLinkPrefixes
        assertEquals(
            "DeepLinkRoute parses these but the manifest never claims them, so Android " +
                "delivers the link to a BROWSER and the seller lands on the website: $unclaimed",
            emptySet<String>(),
            unclaimed,
        )
    }

    @Test
    fun `every manifest prefix resolves to a route`() {
        val parsed = segmentsOf("private fun fromAppLink(")
        // oauth/ebay is claimed on purpose and handled OUTSIDE DeepLinkRoute —
        // EbayOAuthCallbacks takes the whole Uri, because the consent
        // bounce-back needs the query string, not a reduced nav destination.
        val handledElsewhere = setOf("oauth/ebay")
        val orphaned = manifestAppLinkPrefixes - parsed - handledElsewhere
        assertEquals(
            "The manifest claims these but nothing routes them, so the link opens the app " +
                "and goes nowhere — worse than a browser, because the seller is now looking at " +
                "a screen they did not ask for: $orphaned",
            emptySet<String>(),
            orphaned,
        )
    }

    @Test
    fun `oauth-ebay is still handled on BOTH entry points`() {
        // Guards the exemption above: if EbayOAuthCallbacks stops being wired,
        // the prefix becomes genuinely orphaned and the test that would have
        // caught it is the one exempting it.
        //
        // ⚠ BOTH call sites, not "at least one", and sabotage is what found
        // that. An earlier version asserted mere presence of
        // `EbayOAuthCallbacks.offer` — which stays true when one of the two is
        // deleted, so removing either survived the test.
        //
        // They are not interchangeable. `onCreate` covers a COLD start;
        // `onNewIntent` covers the app already running, and for an OAuth
        // bounce-back out of a Custom Tab the app is almost always already
        // running — MainActivity is `singleTask`, so the returning intent is
        // delivered to `onNewIntent`, never to a fresh `onCreate`. Losing that
        // one breaks eBay linking for nearly every real seller while a cold-
        // start test still passes.
        val main = stripKotlin(read("src/main/java/com/gradethread/app/MainActivity.kt"))

        fun bodyOf(fn: String): String {
            val start = main.indexOf(fn)
            assertTrue("$fn is gone or was renamed", start > -1)
            val end = main.indexOf("\n    override fun ", start + 1)
                .let { if (it > -1) it else main.length }
            return main.substring(start, end)
        }

        assertTrue(
            "onCreate no longer hands the launch intent to EbayOAuthCallbacks — " +
                "the /app/oauth/ebay prefix is exempted from the orphan check on the " +
                "strength of that call",
            bodyOf("override fun onCreate(").contains("EbayOAuthCallbacks.offer"),
        )
        assertTrue(
            "onNewIntent no longer hands the returning intent to EbayOAuthCallbacks. " +
                "MainActivity is singleTask, so the eBay consent bounce-back arrives HERE " +
                "whenever the app is already running, which is nearly always",
            bodyOf("override fun onNewIntent(").contains("EbayOAuthCallbacks.offer"),
        )
    }

    @Test
    fun `auth-callback stays exclusive to AuthCallbackActivity`() {
        // MainActivity must never widen its filter to /app or to
        // /app/auth-callback: the OAuth redirect carries the code, and two
        // activities claiming it is a race the user resolves with a chooser.
        assertTrue(
            "MainActivity claims /app/auth-callback — it belongs to AuthCallbackActivity alone",
            !manifestAppLinkPrefixes.contains("auth-callback"),
        )
        assertTrue(
            "the exact-path auth-callback filter is gone from AuthCallbackActivity",
            manifest.contains("""android:path="/app/auth-callback""""),
        )
        // And DeepLinkRoute must keep REFUSING it rather than routing it.
        assertTrue(
            "DeepLinkRoute no longer refuses auth-callback",
            Regex(""""auth-callback"\s*->\s*null""").containsMatchIn(route),
        )
    }

    @Test
    fun `every custom-scheme host the app parses is claimed`() {
        // The widget and shortcut grammars are claimed by <data android:host>
        // rather than pathPrefix, and they drift the same way.
        val hosts = Regex("""android:host="([a-z-]+)"""").findAll(manifest)
            .map { it.groupValues[1] }.toSet()
        for (host in listOf("widget", "shortcut", "auth-callback")) {
            assertTrue("the `$host` custom-scheme host is no longer claimed", host in hosts)
        }
    }

    @Test
    fun `the scans actually match something`() {
        // Guards the guard. Every assertion above is a set difference, and an
        // empty set on BOTH sides is a pass — so a regex that silently stops
        // matching reports perfect agreement, which is exactly how a source
        // scan passes against broken code.
        assertTrue("no pathPrefix matched in the manifest", manifestAppLinkPrefixes.size >= 10)
        assertTrue("no app-link segments matched", segmentsOf("private fun fromAppLink(").size >= 10)
        assertTrue("no widget segments matched", segmentsOf("private fun fromWidget(").isNotEmpty())
        assertTrue("no shortcut segments matched", segmentsOf("private fun fromShortcut(").isNotEmpty())
    }

    @Test
    fun `shipping specifically is claimed, since that is the one that was broken`() {
        assertTrue("/app/shipping is unclaimed again", "shipping" in manifestAppLinkPrefixes)
    }
}
