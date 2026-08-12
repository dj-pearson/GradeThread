package com.gradethread.app.marketplaces

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-2481 AC1: sold elsewhere, still live on an extension channel.
 *
 * What is pinned here is the refusal, not the happy path. The phone cannot end
 * a Poshmark listing — nothing outside the seller's own logged-in browser can,
 * per `vault/60-decisions/adr-no-server-side-marketplace-automation.md`. So the
 * only two honest offers are "queue it for the desktop" and "I ended it
 * myself", and each has rows it must NOT be offered for. Getting that wrong
 * costs a double sale: a second buyer pays for an item already shipped.
 */
class PendingDelistTest {

    private fun row(
        platform: String = "poshmark",
        url: String? = "https://poshmark.com/listing/abc-123",
        status: String? = "active",
    ) = PendingDelist(
        listingId = "l1",
        platform = platform,
        listingUrl = url,
        listingStatus = status,
        itemId = "i1",
        itemTitle = "Vintage Levi's 501",
    )

    @Test
    fun `a live listing with a url can be queued`() {
        assertNull(pendingDelistBlockedReason(row()))
    }

    @Test
    fun `a draft is refused in its own words, not as a missing url`() {
        // These are two different problems and they send the seller two
        // different places. "No saved URL" for a listing that may never have
        // been published sends them hunting for something that does not exist.
        val reason = pendingDelistBlockedReason(row(status = "draft", url = null))
        assertNotNull(reason)
        assertTrue(
            "a draft must be named as never-confirmed-live, not as a missing URL",
            reason!!.contains("never confirmed it went live"),
        )
    }

    @Test
    fun `a confirmed listing with no url is refused`() {
        val reason = pendingDelistBlockedReason(row(url = null))
        assertNotNull(reason)
        assertTrue(reason!!.contains("No saved listing URL"))

        assertNotNull("blank counts as missing", pendingDelistBlockedReason(row(url = "  ")))
    }

    @Test
    fun `a channel the extension does not handle is refused`() {
        // eBay, Shopify and Depop are ended server-side and never reach this
        // list. If one somehow does, queueing it would produce a job the drain
        // rejects — which reads, from the phone, exactly like a job about to run.
        assertNotNull(pendingDelistBlockedReason(row(platform = "ebay")))
        assertNotNull(pendingDelistBlockedReason(row(platform = "depop")))
    }

    @Test
    fun `every channel the web can delist is one this phone can queue`() {
        // Mirrors LISTER_EXTENSION_PLATFORMS in src/lib/lister-extension.ts.
        // A channel that drops out of this set silently loses its phone path.
        assertEquals(
            setOf("poshmark", "mercari", "grailed", "vinted", "facebook"),
            EXTENSION_DELIST_PLATFORMS,
        )
        for (platform in EXTENSION_DELIST_PLATFORMS) {
            assertNull(platform, pendingDelistBlockedReason(row(platform = platform)))
        }
    }

    @Test
    fun `a row reads as still live, never as handled`() {
        val text = describePendingDelist(row())
        assertTrue(text.contains("Vintage Levi's 501"))
        assertTrue("the row must say the listing is STILL up", text.contains("still live"))
        assertTrue("and name the channel it is up on", text.contains("Poshmark"))
    }

    @Test
    fun `an untitled item still names its channel`() {
        // A row with no title must not degrade into a blank line the seller
        // scrolls past — this list is the last warning before a double sale.
        val text = describePendingDelist(
            PendingDelist(listingId = "l2", platform = "mercari", itemId = "i2"),
        )
        assertTrue(text.contains("Untitled item"))
        assertTrue(text.contains("Mercari"))
    }
}
