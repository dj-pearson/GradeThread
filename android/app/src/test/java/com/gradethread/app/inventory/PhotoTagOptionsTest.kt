package com.gradethread.app.inventory

import com.gradethread.app.capture.PhotoProfile
import com.gradethread.app.capture.PhotoRole
import com.gradethread.app.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-2469: the retag menu's grouping rule.
 *
 * The rule IS the feature — the seller report that opened the epic was "tags
 * are tough to navigate", and what made them tough was a flat 28-entry list
 * where six entries were near-duplicates of each other. So these assertions are
 * about what a seller is offered and in what order, not about rendering.
 */
class PhotoTagOptionsTest {

    private fun role(type: String, label: String, role: String? = null) =
        PhotoRole(type, label, "", required = false, icon = "x", role = role)

    private val suit = PhotoProfile(
        category = "clothing:suit",
        label = "Suit",
        roles = listOf(
            role("front", "Front"),
            role("back", "Back"),
            role("tag", "Brand label", "brand"),
            role("tag", "Size tag", "size"),
            role("tag", "Trouser size tag", "size_alt"),
            role("detail", "Fabric close-up", "fabric"),
            role("measurement", "Measure: Chest", "chest"),
            role("measurement", "Measure: Inseam", "inseam"),
        ),
    )

    @Test
    fun `a suit gets three separate tag slots`() {
        // The concrete failing case in the story: a blazer plus dress pants
        // needs a size tag per piece, and the old enum could only offer `tag`
        // and `tag_2`. Three distinct slots on ONE type is what the role
        // qualifier bought.
        val menu = PhotoTagOptions.build("tag", "brand", suit)
        val tagSlots = menu.suggested.filter { it.type == "tag" }
        assertEquals(3, tagSlots.size)
        assertEquals(
            listOf("tag:brand", "tag:size", "tag:size_alt"),
            tagSlots.map { it.slot },
        )
    }

    @Test
    fun `suggested is in capture order, not alphabetical`() {
        // Front → Back → Tag → Detail → measurements is the order a seller
        // shoots in, so the next tag they want is the next one down. Sorting it
        // would put "Back" above "Front".
        val menu = PhotoTagOptions.build("front", null, suit)
        // US-2976: the profile's own wording, which is server data and rides as
        // `detail`. The ORDER is what this test is about and it is unchanged.
        assertEquals(
            listOf("Front", "Back", "Brand label", "Size tag", "Trouser size tag"),
            menu.suggested.take(5).map { it.label.detail },
        )
    }

    @Test
    fun `all types excludes what is already suggested`() {
        // US-2976: the alphabetical assertion MOVED with the sort. Ordering
        // followed the display text, and display text is per-language now, so
        // the screen sorts after resolving and this object no longer can.
        val menu = PhotoTagOptions.build("front", null, suit)
        val res = menu.allTypes.map { it.label.res }
        val suggestedSlots = menu.suggested.map { it.slot }.toSet()
        assertTrue(menu.allTypes.none { it.slot in suggestedSlots })
        // Demoted, never removed: a type the profile does not suggest is still
        // reachable, just further down.
        assertTrue(R.string.photo_type_sole in res)
        assertTrue(R.string.photo_type_certificate in res)
    }

    @Test
    fun `nothing retired is ever offered as a new choice`() {
        val menu = PhotoTagOptions.build("front", null, suit)
        val offered = (menu.suggested + menu.allTypes).map { it.type }.toSet()
        for (t in listOf("tag_2", "detail_2", "detail_3", "detail_4", "measurement_chest")) {
            assertFalse("$t was offered", t in offered)
        }
    }

    @Test
    fun `a profile cannot resurrect a retired type`() {
        // The profile table is server data this client did not author, so a
        // stale row naming `detail_2` must not put it back in the picker.
        val stale = PhotoProfile(
            category = "clothing",
            label = "Clothing",
            roles = listOf(role("front", "Front"), role("detail_2", "Detail 2")),
        )
        val menu = PhotoTagOptions.build("front", null, stale)
        assertTrue(menu.suggested.none { it.type == "detail_2" })
    }

    @Test
    fun `a photo on a retired type is shown as an orphan rather than a blank`() {
        // A row migration 00587 has not reached yet. Without this the menu shows
        // nothing selected and the seller cannot tell what they are changing FROM.
        val menu = PhotoTagOptions.build("measurement_chest", null, suit)
        assertNotNull(menu.orphan)
        assertEquals(R.string.photo_type_measurement_chest, menu.orphan?.label?.res)
        assertEquals("measurement_chest", menu.current)
    }

    @Test
    fun `a photo on an offered slot has no orphan row`() {
        assertNull(PhotoTagOptions.build("front", null, suit).orphan)
        assertNull(PhotoTagOptions.build("tag", "size_alt", suit).orphan)
        // A bare `sole` is offered by the All types section even though the
        // suit profile never suggests it.
        assertNull(PhotoTagOptions.build("sole", null, suit).orphan)
    }

    @Test
    fun `the current slot is the pair, so two tag photos are told apart`() {
        assertEquals("tag:size", PhotoTagOptions.build("tag", "size", suit).current)
        assertEquals("tag:size_alt", PhotoTagOptions.build("tag", "size_alt", suit).current)
    }

    @Test
    fun `a duplicate slot in a server profile produces one row, not two`() {
        val dupes = PhotoProfile(
            category = "clothing",
            label = "Clothing",
            roles = listOf(
                role("tag", "Brand label", "brand"),
                role("tag", "Brand label again", "brand"),
            ),
        )
        val menu = PhotoTagOptions.build("front", null, dupes)
        assertEquals(1, menu.suggested.count { it.slot == "tag:brand" })
    }

    @Test
    fun `a role the profile does not suggest is demoted, not hidden`() {
        // US-2461 AC4. "All types" used to be built from BARE types, so the only
        // roles a phone could reach were the ones the item's profile happened to
        // name. The suit profile below suggests `detail:fabric` and three of the
        // four tag roles — so before this, "Hem & stitching" and "Made in /
        // union label" were unreachable on Android and reachable on web.
        val res = PhotoTagOptions.build("front", null, suit).allTypes.map { it.label.res }
        assertTrue(R.string.photo_role_detail_hem in res)
        assertTrue(R.string.photo_role_detail_hardware in res)
        assertTrue(R.string.photo_role_tag_made_in in res)
    }

    @Test
    fun `a type that takes a role is never offered bare`() {
        // An unqualified "Detail" would compete with "Fabric close-up" for the
        // same slot, and a bare `measurement` is the MeasureCard calibration
        // frame — a different photo, written by a different flow.
        val menu = PhotoTagOptions.build("front", null, suit)
        val offered = menu.suggested + menu.allTypes
        for (t in listOf("tag", "detail", "measurement")) {
            assertFalse(
                "a bare $t was offered",
                offered.any { it.type == t && it.role == null },
            )
        }
    }

    @Test
    fun `group-specific roles follow the garment, not the whole catalog`() {
        // "Handles & straps" in a t-shirt's menu is the noise this epic removed.
        val bag = PhotoProfile(
            category = "bags",
            label = "Bags",
            roles = listOf(role("front", "Front")),
        )
        val bagRes = PhotoTagOptions.build("front", null, bag).allTypes.map { it.label.res }
        assertTrue(R.string.photo_role_detail_handles in bagRes)
        assertFalse(R.string.photo_role_tag_size_alt in bagRes)

        val suitRes = PhotoTagOptions.build("front", null, suit).allTypes.map { it.label.res }
        assertFalse(R.string.photo_role_detail_handles in suitRes)
        assertFalse(R.string.photo_role_detail_insole in suitRes)
    }

    @Test
    fun `a t-shirt is never offered an inseam and a suit is`() {
        val tee = PhotoProfile(
            category = "clothing:top",
            label = "Top",
            roles = listOf(
                role("front", "Front"),
                role("measurement", "Measure: Chest", "chest"),
                role("measurement", "Measure: Sleeve", "sleeve"),
            ),
        )
        val teeSlots = PhotoTagOptions.build("front", null, tee).suggested.map { it.slot }
        assertFalse("measurement:inseam" in teeSlots)
        val suitSlots = PhotoTagOptions.build("front", null, suit).suggested.map { it.slot }
        assertTrue("measurement:inseam" in suitSlots)
    }
}
