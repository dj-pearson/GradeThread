package com.gradethread.app.marketplaces

import android.content.Intent
import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The Scout sold-comps link has to reach the eBay APP, not a Custom Tab.
 *
 * A Custom Tab is a browser, so it renders the logged-out mobile page even when
 * the seller has eBay installed — which is what shipped, and is why this test
 * exists. The flags below are the whole mechanism: without REQUIRE_NON_BROWSER
 * the system hands the link back to the default browser and nothing changes.
 */
@RunWith(RobolectricTestRunner::class)
class MarketplaceAppLinkTest {

    private val soldSearch: Uri =
        Uri.parse("https://www.ebay.com/sch/i.html?_nkw=patagonia&LH_Sold=1&LH_Complete=1")

    @Config(sdk = [34])
    @Test
    fun `asks for a non-browser handler on modern Android`() {
        val intent = CustomTabsLauncher.marketplaceAppIntent(soldSearch)!!
        assertEquals(Intent.ACTION_VIEW, intent.action)
        assertEquals(soldSearch, intent.data)
        assertNotEquals(
            "REQUIRE_NON_BROWSER is what routes this to the eBay app",
            0,
            intent.flags and Intent.FLAG_ACTIVITY_REQUIRE_NON_BROWSER,
        )
        assertNotEquals(
            "launching from a Composable needs its own task",
            0,
            intent.flags and Intent.FLAG_ACTIVITY_NEW_TASK,
        )
    }

    @Config(sdk = [29])
    @Test
    fun `below API 30 there is no app-only intent, so the caller falls back`() {
        // REQUIRE_NON_BROWSER did not exist yet. Sending the intent without it
        // would show a "complete action using" chooser, which is worse than the
        // Custom Tab we already had.
        assertNull(CustomTabsLauncher.marketplaceAppIntent(soldSearch))
    }

    @Config(sdk = [34])
    @Test
    fun `the query string survives the hand-off`() {
        // A dropped LH_Sold lands the seller on ACTIVE asking prices while the
        // button still says "sold" — the one failure that misleads instead of
        // annoying.
        val intent = CustomTabsLauncher.marketplaceAppIntent(soldSearch)!!
        assertEquals("1", intent.data?.getQueryParameter("LH_Sold"))
        assertEquals("1", intent.data?.getQueryParameter("LH_Complete"))
        assertEquals("patagonia", intent.data?.getQueryParameter("_nkw"))
    }
}
