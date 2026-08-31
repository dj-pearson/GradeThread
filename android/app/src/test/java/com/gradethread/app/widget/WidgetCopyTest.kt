package com.gradethread.app.widget

import androidx.test.core.app.ApplicationProvider
import com.gradethread.app.money.Money
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * US-1380 AC3, moved here by US-2976: every word the widget says.
 *
 * The TalkBack labels are the only version of this widget a blind seller ever
 * gets, so they are asserted rather than merely written. They used to be
 * asserted from a plain JUnit test because WidgetCopy built its sentences in
 * Kotlin; they come from resources now, so this needs a Context and Robolectric
 * supplies one. The COVERAGE did not change - the test moved.
 *
 * ⚠ THE SENTENCES ARE ASSERTED WHOLE, on purpose. Each one is now assembled
 * from a format string and two or three arguments, and asserting the arguments
 * alone would pass on a format string that dropped one.
 */
@RunWith(RobolectricTestRunner::class)
class WidgetCopyTest {

    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

    @Test
    fun `signed out speaks the prompt, not zeros`() {
        assertEquals(
            WidgetCopy.signedOut(context),
            WidgetCopy.accessibilityLabel(context, WidgetSnapshot.signedOut()),
        )
    }

    @Test
    fun `every number is spoken with its unit`() {
        val snapshot = WidgetSnapshot(
            generatedAt = 0L,
            isSignedIn = true,
            activeListings = 1,
            soldTodayCount = 2,
            soldTodayGross = 60.0,
            pendingPayoutCount = 3,
            pendingPayoutNet = 90.0,
        )

        assertEquals(
            "Seller snapshot. 1 active listing. 2 sales today, ${Money.format(60.0)}. " +
                "${Money.format(90.0)} pending across 3 sales.",
            WidgetCopy.accessibilityLabel(context, snapshot),
        )
    }

    @Test
    fun `a quiet day says so rather than reading out zeros`() {
        val snapshot = WidgetSnapshot(generatedAt = 0L, isSignedIn = true, activeListings = 0)

        assertEquals(
            "Seller snapshot. 0 active listings. Nothing sold today. No payouts pending.",
            WidgetCopy.accessibilityLabel(context, snapshot),
        )
    }

    @Test
    fun `each tappable region says where it goes`() {
        val snapshot = WidgetSnapshot.PLACEHOLDER
        assertTrue(
            WidgetCopy.listingsActionLabel(context, snapshot).endsWith("Opens marketplaces."),
        )
        assertTrue(WidgetCopy.moneyActionLabel(context, snapshot).endsWith("Opens money."))
        assertTrue(WidgetCopy.pendingActionLabel(context, snapshot).endsWith("Opens money."))
    }

    @Test
    fun `tile subtitles carry the unit`() {
        val snapshot = WidgetSnapshot(
            generatedAt = 0L,
            isSignedIn = true,
            soldTodayCount = 1,
            pendingPayoutCount = 4,
        )
        assertEquals("1 sale", WidgetCopy.soldTodaySub(context, snapshot))
        assertEquals("4 sales", WidgetCopy.pendingSub(context, snapshot))
    }

    @Test
    fun `the freshness stamp`() {
        // US-2435: must exceed the largest offset subtracted below (2 days =
        // 172,800,000). The original 10_000_000L is only 2h46m past the epoch,
        // so `now - 3h` and `now - 2d` went NEGATIVE and tripped WidgetCopy's
        // "never published" guard (generatedAtMs <= 0 -> null) instead of
        // reaching the formatter. The two assertions below had therefore never
        // passed, on any commit.
        val now = 10_000_000_000L
        assertEquals("Updated just now", WidgetCopy.updatedAgo(context, now - 30_000, now))
        assertEquals("Updated 5m ago", WidgetCopy.updatedAgo(context, now - 5 * 60_000, now))
        assertEquals("Updated 3h ago", WidgetCopy.updatedAgo(context, now - 3 * 3_600_000, now))
        assertEquals("Updated 2d ago", WidgetCopy.updatedAgo(context, now - 2 * 86_400_000L, now))
        // Never published, and never claim the future.
        assertNull(WidgetCopy.updatedAgo(context, 0L, now))
        assertNull(WidgetCopy.updatedAgo(context, now + 60_000, now))
    }
}
