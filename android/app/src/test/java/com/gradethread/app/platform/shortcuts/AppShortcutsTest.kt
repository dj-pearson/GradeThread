package com.gradethread.app.platform.shortcuts

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.gradethread.app.money.Money
import com.gradethread.app.ui.text
import com.gradethread.app.widget.WidgetSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * US-1381: the "what sold today" answer and the shortcut specs.
 *
 * The answer is composed with the app closed, from a snapshot on disk, and
 * rendered by the launcher — so there is no moment at which anyone would see it
 * come out wrong. These are that moment.
 *
 * US-2976: the sentences live in strings.xml now, so rendering one needs a
 * Context and Robolectric supplies it. They are still asserted WHOLE. Checking
 * the resource id instead would prove which branch ran and nothing about what
 * the launcher shows, and this file exists precisely because nobody is watching
 * when it is shown.
 */
@RunWith(RobolectricTestRunner::class)
class AppShortcutsTest {

    private val context = ApplicationProvider.getApplicationContext<Context>()

    private fun snapshot(
        signedIn: Boolean = true,
        soldCount: Int = 0,
        soldGross: Double = 0.0,
        pendingCount: Int = 0,
        pendingNet: Double = 0.0,
    ) = WidgetSnapshot(
        generatedAt = 1L,
        isSignedIn = signedIn,
        soldTodayCount = soldCount,
        soldTodayGross = soldGross,
        pendingPayoutCount = pendingCount,
        pendingPayoutNet = pendingNet,
    )

    // ── The answer ───────────────────────────────────────────────────────────

    @Test
    fun `nothing published yet asks them to sign in, rather than reading zeros`() {
        // Zeros would sound like a dead business. "We don't know yet" is the
        // truth, and it is a different sentence.
        assertEquals(
            "Sign in to see what sold today",
            SoldTodaySummary.dialog(null).text(context),
        )
        assertEquals(
            SoldTodaySummary.SIGNED_OUT,
            SoldTodaySummary.dialog(snapshot(signedIn = false)),
        )
    }

    @Test
    fun `a quiet day is said out loud`() {
        assertEquals(
            "Nothing's sold yet today. No payouts are waiting.",
            SoldTodaySummary.dialog(snapshot()).text(context),
        )
    }

    @Test
    fun `one sale is singular`() {
        assertEquals(
            "You've sold 1 item today for ${Money.format(42.0)}. " +
                "${Money.format(30.0)} is waiting from 1 sale.",
            SoldTodaySummary.dialog(
                snapshot(soldCount = 1, soldGross = 42.0, pendingCount = 1, pendingNet = 30.0),
            ).text(context),
        )
    }

    @Test
    fun `several sales are plural`() {
        assertEquals(
            "You've sold 4 items today for ${Money.format(184.0)}. " +
                "${Money.format(312.55)} is waiting from 5 sales.",
            SoldTodaySummary.dialog(
                snapshot(soldCount = 4, soldGross = 184.0, pendingCount = 5, pendingNet = 312.55),
            ).text(context),
        )
    }

    @Test
    fun `a quiet day with money still coming says both`() {
        val dialog = SoldTodaySummary
            .dialog(snapshot(pendingCount = 2, pendingNet = 90.0))
            .text(context)
        assertTrue(dialog.startsWith("Nothing's sold yet today."))
        assertTrue(dialog.endsWith("is waiting from 2 sales."))
    }

    // ── The label ────────────────────────────────────────────────────────────

    @Test
    fun `the short label leads with the money`() {
        // Launchers truncate at a width nobody can predict, so the figure being
        // asked about has to survive the cut.
        assertEquals(
            "${Money.format(184.0)} today",
            SoldTodaySummary.shortLabel(snapshot(soldCount = 4, soldGross = 184.0)).text(context),
        )
        assertEquals("Nothing sold today", SoldTodaySummary.shortLabel(snapshot()).text(context))
        assertEquals("Sold today", SoldTodaySummary.shortLabel(null).text(context))
    }

    // ── The specs ────────────────────────────────────────────────────────────

    @Test
    fun `the dynamic shortcut is still offered when signed out`() {
        // A menu item that silently disappears leaves someone thinking the app
        // is broken. A label that explains is better than an absence.
        val spec = AppShortcuts.soldTodaySpec(null)

        assertEquals(AppShortcuts.ID_SOLD_TODAY, spec.id)
        assertEquals(SoldTodaySummary.SIGNED_OUT, spec.longLabel)
        assertEquals("Sign in to see what sold today", spec.longLabel.text(context))
        assertEquals("com.gradethread.app://shortcut/money", spec.uri)
    }

    @Test
    fun `the dynamic shortcut carries the answer as its label`() {
        val spec = AppShortcuts.soldTodaySpec(snapshot(soldCount = 2, soldGross = 60.0))

        assertTrue(spec.longLabel.text(context).startsWith("You've sold 2 items today"))
        assertEquals("${Money.format(60.0)} today", spec.shortLabel.text(context))
    }

    /**
     * US-2976: the Spanish plural forms, rendered.
     *
     * The English "1 item / 2 items" split survives a bad plurals block by
     * accident - "other" is what English uses for everything except one, so a
     * translator who fills in only "other" still passes every test above. This
     * one does not: it asserts the ONE form and the OTHER form differ in
     * Spanish, which is the mistake worth catching.
     */
    @Test
    @Config(qualifiers = "es")
    fun `the Spanish answer agrees with its own numbers`() {
        val one = SoldTodaySummary
            .dialog(snapshot(soldCount = 1, soldGross = 42.0, pendingCount = 1, pendingNet = 30.0))
            .text(context)
        val many = SoldTodaySummary
            .dialog(snapshot(soldCount = 4, soldGross = 184.0, pendingCount = 5, pendingNet = 90.0))
            .text(context)

        assertTrue(one, one.contains("1 art\u00edculo") && !one.contains("art\u00edculos"))
        assertTrue(many, many.contains("4 art\u00edculos"))
        assertTrue(one, one.contains("1 venta") && !one.contains("ventas"))
        assertTrue(many, many.contains("5 ventas"))
    }

    @Test
    fun `the static shortcut xml and the kotlin constants agree`() {
        // The XML is what actually ships; the constants are what the tests and
        // the dynamic shortcut use. Nothing else keeps the two honest, and a
        // drifted id means the Assistant capability binds to a shortcut that
        // does not exist.
        val xml = java.io.File("src/main/res/xml/shortcuts.xml").readText()

        listOf(AppShortcuts.ID_SNAP, AppShortcuts.ID_ADD, AppShortcuts.ID_SOLD_TODAY)
            .forEach { assertTrue(it, xml.contains("\"$it\"")) }
        AppShortcuts.STATIC_URIS.forEach { assertTrue(it, xml.contains(it)) }
        // An https link here would open a browser on an unverified debug build.
        assertTrue(
            "shortcuts.xml must not carry https links",
            !xml.contains("android:data=\"https://"),
        )
    }

    @Test
    fun `shortcut links use the custom scheme, never the https app link`() {
        // App Links are only verified on the RELEASE build, so an https
        // shortcut opens a browser on a debug build.
        (AppShortcuts.STATIC_URIS + AppShortcuts.soldTodaySpec(null).uri).forEach { uri ->
            assertTrue(uri, uri.startsWith("${AppShortcuts.SCHEME}://${AppShortcuts.HOST}/"))
        }
    }
}
