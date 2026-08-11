package com.gradethread.app.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * US-2469: `GarmentGroup.from` is a Kotlin mirror of `measurementGroupFor`
 * (src/lib/measurement-templates.ts). It has to be duplicated rather than
 * fetched — the profile table is cached for offline use, so picking a key
 * cannot be a network dependency — and a duplicated regex with no test is a
 * drift bug waiting to happen.
 *
 * These are deliberately the SAME cases `src/test/measurement-template-parity.test.ts`
 * and `ios/GradeThreadTests/GarmentGroupTests.swift` assert, so a change on one
 * side that is not mirrored fails on the others.
 */
class GarmentGroupTest {

    @Test
    fun `dress is a modifier more often than a noun`() {
        // The bug that opened the epic: the dress branch is tested before both
        // bottom and top, so every "dress <noun>" compound was measured as a
        // dress. A seller listing dress pants was asked for a bust and never
        // once for an inseam.
        for (c in listOf("dress pants", "dress trousers", "dress slacks", "dress shorts")) {
            assertEquals(c, GarmentGroup.BOTTOM, GarmentGroup.from(c))
        }
        for (c in listOf("dress shirt", "Dress Shirts", "dress blouse")) {
            assertEquals(c, GarmentGroup.TOP, GarmentGroup.from(c))
        }
    }

    @Test
    fun `an actual dress is still a dress`() {
        // Why the fix is a compound guard and not a branch reorder: these are
        // genuine dresses whose names contain another garment's noun, and any
        // reorder that fixed "dress shirt" would have broken them.
        for (c in listOf("dress", "sundress", "shirtdress", "maxi dress", "romper", "jumpsuit")) {
            assertEquals(c, GarmentGroup.DRESS, GarmentGroup.from(c))
        }
    }

    @Test
    fun `compounds an earlier branch already owned`() {
        assertEquals(GarmentGroup.SHOES, GarmentGroup.from("dress shoes"))
        assertEquals(GarmentGroup.ACCESSORY, GarmentGroup.from("dress belt"))
        assertEquals(GarmentGroup.OUTERWEAR, GarmentGroup.from("dress coat"))
    }

    @Test
    fun `suit sets are measured as a top and a bottom`() {
        for (
            c in listOf(
                "suit", "Suit Set", "two piece suit", "three-piece suit", "tuxedo",
                "pantsuit", "coveralls", "overalls", "tracksuit", "sweatsuit",
                "pajamas", "scrubs",
            )
        ) {
            assertEquals(c, GarmentGroup.SUIT, GarmentGroup.from(c))
        }
    }

    @Test
    fun `words that merely contain suit are not suit sets`() {
        // A swimsuit and a bodysuit are single garments; a jumpsuit is measured
        // like a dress. Tracksuits and sweatsuits are NOT excluded — they are
        // two pieces and a buyer needs both sets of numbers.
        assertEquals(GarmentGroup.DRESS, GarmentGroup.from("swimsuit"))
        assertEquals(GarmentGroup.DRESS, GarmentGroup.from("jumpsuit"))
        assertEquals(GarmentGroup.GENERIC, GarmentGroup.from("wetsuit"))
    }

    @Test
    fun `a single named piece wins over the set`() {
        // A standalone suit jacket is outerwear and suit pants are a bottom.
        // Only the set gets both halves.
        assertEquals(GarmentGroup.OUTERWEAR, GarmentGroup.from("suit jacket"))
        assertEquals(GarmentGroup.BOTTOM, GarmentGroup.from("suit pants"))
        assertEquals(GarmentGroup.BOTTOM, GarmentGroup.from("tuxedo trousers"))
    }

    @Test
    fun `the garments that used to fall to generic`() {
        assertEquals(GarmentGroup.DRESS, GarmentGroup.from("bikini"))
        assertEquals(GarmentGroup.BOTTOM, GarmentGroup.from("swim trunks"))
        assertEquals(GarmentGroup.BOTTOM, GarmentGroup.from("board shorts"))
        assertEquals(GarmentGroup.OUTERWEAR, GarmentGroup.from("bathrobe"))
        assertEquals(GarmentGroup.OUTERWEAR, GarmentGroup.from("kimono"))
        assertEquals(GarmentGroup.OUTERWEAR, GarmentGroup.from("poncho"))
    }

    @Test
    fun `the coarse garment type values resolve`() {
        // The clients store GARMENT_TYPES in `garmentType` and fall back to it
        // when `garmentCategory` is empty, so these six have to land somewhere
        // real rather than in `generic`.
        assertEquals(GarmentGroup.TOP, GarmentGroup.from("tops"))
        assertEquals(GarmentGroup.BOTTOM, GarmentGroup.from("bottoms"))
        assertEquals(GarmentGroup.DRESS, GarmentGroup.from("dresses"))
        assertEquals(GarmentGroup.OUTERWEAR, GarmentGroup.from("outerwear"))
        assertEquals(GarmentGroup.SHOES, GarmentGroup.from("footwear"))
        assertEquals(GarmentGroup.ACCESSORY, GarmentGroup.from("accessories"))
    }

    @Test
    fun `bags win the noun`() {
        // The noun that matters is the LAST one. Routing these to the shoe
        // template would ask the seller for an insole length.
        assertEquals(GarmentGroup.BAG, GarmentGroup.from("boot bag"))
        assertEquals(GarmentGroup.BAG, GarmentGroup.from("shoe bag"))
        assertEquals(GarmentGroup.BAG, GarmentGroup.from("tie bag"))
        assertEquals(GarmentGroup.BAG, GarmentGroup.from("hat bag"))
    }

    @Test
    fun `empty and unknown fall to generic`() {
        assertEquals(GarmentGroup.GENERIC, GarmentGroup.from(null))
        assertEquals(GarmentGroup.GENERIC, GarmentGroup.from(""))
        assertEquals(GarmentGroup.GENERIC, GarmentGroup.from("socks"))
    }

    @Test
    fun `profile keys join the two taxonomies`() {
        // Measurement groups and item_category are different taxonomies that
        // overlap; a group with its own category profile must resolve to it.
        assertEquals("shoes", GarmentGroup.SHOES.itemCategoryProfileKey)
        assertEquals("watches", GarmentGroup.WATCH.itemCategoryProfileKey)
        assertEquals("bags", GarmentGroup.BAG.itemCategoryProfileKey)
        assertEquals("accessories", GarmentGroup.ACCESSORY.itemCategoryProfileKey)
        assertEquals("headwear", GarmentGroup.HEADWEAR.itemCategoryProfileKey)
        // The clothing groups have none — they use the clothing:<group> key.
        assertNull(GarmentGroup.TOP.itemCategoryProfileKey)
        assertNull(GarmentGroup.SUIT.itemCategoryProfileKey)
        assertEquals("clothing:suit", GarmentGroup.SUIT.clothingProfileKey)
    }
}
