package com.gradethread.app.inventory

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1347: the aspect projection and its provenance — the rules that decide
 * whether a re-save keeps or destroys what someone typed.
 */
class AspectSyncTest {

    private val draft = ItemDraft(
        title = "Better Sweater",
        brand = "Patagonia",
        size = "M",
        color = "Navy",
        material = "Fleece",
        style = "Pullover",
    )

    // ── projection ───────────────────────────────────────────────────────

    @Test
    fun `columns own their aspects and are marked auto-derived`() {
        val (aspects, sources) = AspectSync.projectColumnAspects(draft, emptyMap(), emptyMap())
        assertEquals(listOf("Patagonia"), aspects["Brand"])
        assertEquals(listOf("M"), aspects["Size"])
        assertEquals(listOf("Navy"), aspects["Color"])
        assertEquals(AspectSync.Provenance.INVENTORY_DERIVED, sources["Brand"])
    }

    @Test
    fun `a plain re-save never clobbers an AI or hand-typed aspect`() {
        // THE rule. Aspects with no backing column are untouched, so re-saving
        // an unrelated field can't wipe a specific the AI extracted or the
        // seller typed.
        val existing = mapOf(
            "Sleeve Length" to listOf("Long Sleeve"),
            "Pattern" to listOf("Solid"),
        )
        val existingSources = mapOf(
            "Sleeve Length" to AspectSync.Provenance.AI_EXTRACTED,
            "Pattern" to AspectSync.Provenance.MANUAL,
        )
        val (aspects, sources) = AspectSync.projectColumnAspects(draft, existing, existingSources)
        assertEquals(listOf("Long Sleeve"), aspects["Sleeve Length"])
        assertEquals(AspectSync.Provenance.AI_EXTRACTED, sources["Sleeve Length"])
        assertEquals(AspectSync.Provenance.MANUAL, sources["Pattern"])
    }

    @Test
    fun `clearing a column removes its aspect AND its provenance`() {
        // Leaving the value behind would show a specific the seller can no
        // longer see the source of, and can't remove from the item page.
        val seeded = AspectSync.projectColumnAspects(draft, emptyMap(), emptyMap())
        val (aspects, sources) = AspectSync.projectColumnAspects(
            draft.copy(color = "   "),
            seeded.first,
            seeded.second,
        )
        assertFalse(aspects.containsKey("Color"))
        assertFalse(sources.containsKey("Color"))
        // The others survive.
        assertEquals(listOf("Patagonia"), aspects["Brand"])
    }

    @Test
    fun `a column edit overwrites its own previously-manual aspect`() {
        // The column is the owner: if a seller changes Brand on the item, the
        // Brand specific has to follow or the listing publishes a stale one.
        val (aspects, sources) = AspectSync.projectColumnAspects(
            draft.copy(brand = "Arc'teryx"),
            mapOf("Brand" to listOf("Patagonia")),
            mapOf("Brand" to AspectSync.Provenance.MANUAL),
        )
        assertEquals(listOf("Arc'teryx"), aspects["Brand"])
        assertEquals(AspectSync.Provenance.INVENTORY_DERIVED, sources["Brand"])
    }

    @Test
    fun `only the canonical aspect name is written, not every alias`() {
        // Color/Colour and Material/Fabric Type are the same concept across
        // categories; writing all of them would send eBay duplicates.
        val (aspects, _) = AspectSync.projectColumnAspects(draft, emptyMap(), emptyMap())
        assertTrue(aspects.containsKey("Color"))
        assertFalse(aspects.containsKey("Colour"))
        assertTrue(aspects.containsKey("Material"))
        assertFalse(aspects.containsKey("Fabric Type"))
    }

    // ── manual edits ─────────────────────────────────────────────────────

    @Test
    fun `a manual edit is marked manual and survives`() {
        val (aspects, sources) = AspectSync.setManual(
            emptyMap(), emptyMap(), "Pattern", listOf(" Striped "),
        )
        assertEquals(listOf("Striped"), aspects["Pattern"])
        assertEquals(AspectSync.Provenance.MANUAL, sources["Pattern"])
    }

    @Test
    fun `clearing a manual aspect drops it entirely`() {
        val seeded = AspectSync.setManual(emptyMap(), emptyMap(), "Pattern", listOf("Striped"))
        val (aspects, sources) = AspectSync.setManual(
            seeded.first, seeded.second, "Pattern", listOf("  ", ""),
        )
        assertFalse(aspects.containsKey("Pattern"))
        assertFalse(sources.containsKey("Pattern"))
    }

    // ── the 65-char limit ────────────────────────────────────────────────

    @Test
    fun `an over-long value is flagged before saving, not after`() {
        // eBay rejects it, and the failure surfaces as an unpublishable offer
        // rather than a field error — so the seller has to be told up front.
        assertTrue(AspectSync.willBeTruncated("x".repeat(66)))
        assertFalse(AspectSync.willBeTruncated("x".repeat(65)))
        assertFalse(AspectSync.willBeTruncated("  " + "x".repeat(65) + "  "))
        assertEquals(65, AspectSync.EBAY_ASPECT_VALUE_MAX_LEN)
    }

    // ── required gaps ────────────────────────────────────────────────────

    @Test
    fun `required aspects with no value are the publish blockers`() {
        val missing = AspectSync.requiredMissing(
            listOf("Brand", "Size", "Department"),
            mapOf("Brand" to listOf("Patagonia"), "Size" to emptyList()),
        )
        // Size is present as a key but empty — still missing.
        assertEquals(listOf("Size", "Department"), missing)
    }

    @Test
    fun `nothing required means nothing blocking`() {
        assertTrue(AspectSync.requiredMissing(emptyList(), emptyMap()).isEmpty())
        assertTrue(AspectSync.requiredMissing(listOf("  "), emptyMap()).isEmpty())
    }

    // ── provenance pruning ───────────────────────────────────────────────

    @Test
    fun `pruning drops sources whose aspect lost its value`() {
        val pruned = AspectSync.pruneSources(
            mapOf(
                "Brand" to AspectSync.Provenance.INVENTORY_DERIVED,
                "Pattern" to AspectSync.Provenance.MANUAL,
            ),
            mapOf("Brand" to listOf("Patagonia")),
        )
        assertEquals(setOf("Brand"), pruned.keys)
    }

    // ── jsonb round trip ─────────────────────────────────────────────────

    @Test
    fun `aspects round-trip through the jsonb shape`() {
        val original = mapOf("Brand" to listOf("Patagonia"), "Features" to listOf("Pockets", "Zip"))
        assertEquals(original, AspectSync.decodeAspects(AspectSync.encodeAspects(original)))
    }

    @Test
    fun `empty aspect lists are dropped on both encode and decode`() {
        assertNull(AspectSync.encodeAspects(mapOf("Brand" to emptyList())))
        assertNull(AspectSync.encodeAspects(emptyMap()))
        assertEquals(
            mapOf("Brand" to listOf("Patagonia")),
            AspectSync.decodeAspects("""{"Brand":["Patagonia"],"Size":[],"Color":["  "]}"""),
        )
    }

    @Test
    fun `a malformed aspects document degrades to empty`() {
        assertEquals(emptyMap<String, List<String>>(), AspectSync.decodeAspects("not json"))
        assertEquals(emptyMap<String, List<String>>(), AspectSync.decodeAspects("[1,2]"))
        assertEquals(emptyMap<String, List<String>>(), AspectSync.decodeAspects(null))
    }

    @Test
    fun `an unrecognised provenance is dropped rather than guessed at`() {
        // A missing key already means "source unknown", so re-badging a value
        // this client doesn't understand would assert something false.
        val decoded = AspectSync.decodeSources(
            """{"Brand":"inventory_derived","Pattern":"imported_from_mars"}""",
        )
        assertEquals(mapOf("Brand" to AspectSync.Provenance.INVENTORY_DERIVED), decoded)
    }

    @Test
    fun `sources round-trip`() {
        val original = mapOf(
            "Brand" to AspectSync.Provenance.INVENTORY_DERIVED,
            "Pattern" to AspectSync.Provenance.MANUAL,
            "Fit" to AspectSync.Provenance.AI_EXTRACTED,
        )
        assertEquals(original, AspectSync.decodeSources(AspectSync.encodeSources(original)))
        assertNull(AspectSync.encodeSources(emptyMap()))
    }

    // ── the registry ─────────────────────────────────────────────────────

    @Test
    fun `the registry mirrors the web JSON it was ported from`() {
        // Ported as code so drift fails a test instead of silently reading a
        // stale asset. 18 entries, version 1.
        assertEquals(18, AspectRegistry.entries.size)
        assertEquals(5, AspectRegistry.columnEntries.size)
        assertEquals(
            listOf("brand", "size", "color", "material", "style"),
            AspectRegistry.columnEntries.map { it.field },
        )
        // `features` is the one multi-valued entry (US-821).
        assertEquals(
            listOf("features"),
            AspectRegistry.entries.filter { it.multi }.map { it.field },
        )
    }

    @Test
    fun `an aspect name maps back to the field it syncs with`() {
        assertEquals("brand", AspectRegistry.syncedFieldFor("Brand"))
        // Aliases resolve too, and matching is case-insensitive.
        assertEquals("color", AspectRegistry.syncedFieldFor("Colour"))
        assertEquals("material", AspectRegistry.syncedFieldFor("fabric type"))
        assertEquals("department", AspectRegistry.syncedFieldFor("Department"))
        // A free-typed aspect belongs to no field.
        assertNull(AspectRegistry.syncedFieldFor("Character"))
        assertNull(AspectRegistry.syncedFieldFor("  "))
    }
}
