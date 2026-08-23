package com.gradethread.app.ai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1334 (AC3): where each field is written, and what is refused.
 *
 * Both failure modes here are silent-and-destructive, which is why they are
 * tested rather than trusted: an unknown column fails the WHOLE update, and a
 * jsonb write REPLACES the whole document.
 */
class AiItemFieldsTest {

    // ── column vs attribute routing ──────────────────────────────────────

    @Test
    fun ordinaryFieldsRouteToColumns() {
        val routed = AiItemFields.route(mapOf("brand" to "Nike", "size" to "M"))
        assertEquals(mapOf("brand" to "Nike", "size" to "M"), routed.columns)
        assertTrue(routed.attributes.isEmpty())
    }

    @Test
    fun departmentRoutesToAttributesNotAColumn() {
        // The one that bites: it reads like an ordinary field, has no column,
        // and writing it top-level fails the entire update.
        val routed = AiItemFields.route(mapOf("department" to "Men"))
        assertEquals(mapOf("department" to "Men"), routed.attributes)
        assertTrue(routed.columns.isEmpty())
    }

    @Test
    fun everyCanonicalAttributeAvoidsTheColumnPath() {
        for (key in AiItemFields.attributeKeys) {
            val routed = AiItemFields.route(mapOf(key to "x"))
            assertTrue("$key routed to a column", routed.columns.isEmpty())
            assertEquals(mapOf(key to "x"), routed.attributes)
        }
    }

    @Test
    fun columnAndAttributeKeysDoNotOverlap() {
        // An overlap would make routing order-dependent and ambiguous.
        assertTrue((AiItemFields.columnFields intersect AiItemFields.attributeKeys).isEmpty())
    }

    @Test
    fun unknownFieldsAreDroppedNotWritten() {
        // PostgREST rejects the whole UPDATE on an unknown column, so one
        // unrecognized suggestion would lose every other field in the write.
        val routed = AiItemFields.route(mapOf("brand" to "Nike", "some_new_field" to "x"))
        assertEquals(mapOf("brand" to "Nike"), routed.columns)
        assertEquals(mapOf("some_new_field" to "unknown field"), routed.rejected)
    }

    // ── enum guards ──────────────────────────────────────────────────────

    @Test
    fun validEnumValuesAreWritable() {
        val routed = AiItemFields.route(
            mapOf("garment_type" to "outerwear", "garment_category" to "jacket"),
        )
        assertEquals(2, routed.columns.size)
    }

    @Test
    fun offVocabularyEnumValuesAreRefused() {
        // An invalid enum fails with 22P02 and takes every other field with it.
        val routed = AiItemFields.route(mapOf("garment_type" to "gilet"))
        assertTrue(routed.columns.isEmpty())
        assertTrue(routed.rejected.containsKey("garment_type"))
    }

    @Test
    fun aRefusedEnumDoesNotCostTheOtherFields() {
        val routed = AiItemFields.route(
            mapOf("garment_category" to "poncho", "brand" to "Nike"),
        )
        assertEquals(mapOf("brand" to "Nike"), routed.columns)
        assertEquals(setOf("garment_category"), routed.rejected.keys)
    }

    /**
     * US-2815: this used to be called enumVocabulariesMatchTheMigration and it
     * NEVER READ A MIGRATION. It asserted a hardcoded count, so it matched only
     * its own past self - and when 00570 added `neckwear` and `gloves` to the
     * garment_category enum, this test kept passing at 20 while the phone
     * silently dropped both values before every write.
     *
     * The name is the part that made it invisible: a reader checking whether
     * the vocabularies were pinned to the schema would have read this name and
     * stopped looking. Renamed to what it does.
     *
     * The claim the old name made is now real, and lives where it can be:
     * src/test/native-garment-vocabulary-parity.test.ts reads
     * src/lib/constants.ts and BOTH native vocabularies.
     */
    @Test
    fun enumVocabulariesHaveTheExpectedShape() {
        assertTrue("outerwear" in AiItemFields.garmentTypes)
        assertTrue("accessories" in AiItemFields.garmentTypes)
        assertEquals(6, AiItemFields.garmentTypes.size)
        assertTrue("t-shirt" in AiItemFields.garmentCategories)
        assertTrue("other" in AiItemFields.garmentCategories)
        // 22 since migration 00570 (neckwear, gloves).
        assertTrue("neckwear" in AiItemFields.garmentCategories)
        assertTrue("gloves" in AiItemFields.garmentCategories)
        assertEquals(22, AiItemFields.garmentCategories.size)
    }

    @Test
    fun nonEnumColumnsAcceptAnyValue() {
        assertTrue(AiItemFields.isWritable("brand", "Some Obscure Brand"))
        assertFalse(AiItemFields.isWritable("garment_type", "Some Obscure Type"))
    }

    // ── clearing ─────────────────────────────────────────────────────────

    @Test
    fun blankValuesClearRatherThanWriteEmptyString() {
        // "" is a real value that renders as blank-but-set downstream.
        val routed = AiItemFields.route(mapOf("brand" to ""))
        assertTrue(routed.columns.isEmpty())
        assertEquals(setOf("brand"), routed.cleared)
    }

    @Test
    fun blankAttributesAreClearedToo() {
        val routed = AiItemFields.route(mapOf("department" to "  "))
        assertTrue(routed.attributes.isEmpty())
        assertEquals(setOf("department"), routed.cleared)
    }

    // ── jsonb merges ─────────────────────────────────────────────────────

    @Test
    fun attributeMergePreservesKeysTheServerGapFilled() {
        // A jsonb UPDATE replaces the document — writing only new keys would
        // silently delete everything persistCanonicalAttributes wrote.
        val merged = AiItemFields.mergeAttributes(
            existing = mapOf("country_of_manufacture" to "Vietnam", "fit" to "Regular"),
            updates = mapOf("department" to "Men"),
        )
        assertEquals(
            mapOf("country_of_manufacture" to "Vietnam", "fit" to "Regular", "department" to "Men"),
            merged,
        )
    }

    @Test
    fun attributeMergeOverwritesTheSameKey() {
        val merged = AiItemFields.mergeAttributes(
            existing = mapOf("fit" to "Regular"),
            updates = mapOf("fit" to "Slim"),
        )
        assertEquals(mapOf("fit" to "Slim"), merged)
    }

    @Test
    fun clearedAttributesAreRemovedFromTheDocument() {
        val merged = AiItemFields.mergeAttributes(
            existing = mapOf("fit" to "Regular", "pattern" to "Plaid"),
            updates = emptyMap(),
            cleared = setOf("pattern"),
        )
        assertEquals(mapOf("fit" to "Regular"), merged)
    }

    @Test
    fun fieldSourcesMergePreservesUnrelatedProvenance() {
        val merged = AiItemFields.mergeFieldSources(
            existing = mapOf("color" to "photo:front"),
            sources = mapOf("brand" to "photo:tag"),
        )
        assertEquals(mapOf("color" to "photo:front", "brand" to "photo:tag"), merged)
    }

    @Test
    fun undoneFieldsLoseTheirAiProvenance() {
        // Otherwise the item claims the AI set a value the seller reverted.
        val merged = AiItemFields.mergeFieldSources(
            existing = mapOf("brand" to "photo:tag", "color" to "photo:front"),
            sources = emptyMap(),
            noLongerAiAttributed = setOf("brand"),
        )
        assertEquals(mapOf("color" to "photo:front"), merged)
    }

    @Test
    fun aReAcceptedFieldKeepsItsProvenanceOverTheRemoval() {
        // Update wins over removal for the same key, so accepting a field
        // does not strip the source that was just written for it.
        val merged = AiItemFields.mergeFieldSources(
            existing = emptyMap(),
            sources = mapOf("brand" to "live-text"),
            noLongerAiAttributed = emptySet(),
        )
        assertEquals(mapOf("brand" to "live-text"), merged)
    }

    // ── end-to-end routing of a realistic review ─────────────────────────

    @Test
    fun aMixedReviewRoutesEveryPartCorrectly() {
        val routed = AiItemFields.route(
            mapOf(
                "brand" to "Patagonia",
                "garment_category" to "jacket",
                "department" to "Men",
                "size" to "",
                "garment_type" to "not-a-type",
                "mystery" to "x",
            ),
        )
        assertEquals(mapOf("brand" to "Patagonia", "garment_category" to "jacket"), routed.columns)
        assertEquals(mapOf("department" to "Men"), routed.attributes)
        assertEquals(setOf("size"), routed.cleared)
        assertEquals(setOf("garment_type", "mystery"), routed.rejected.keys)
    }
}
