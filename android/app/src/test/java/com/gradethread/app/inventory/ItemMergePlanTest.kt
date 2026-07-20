package com.gradethread.app.inventory

import com.gradethread.app.inventory.ItemMergePlan.Field
import com.gradethread.app.inventory.ItemMergePlan.Value
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1330: the duplicate-SKU merge math (iOS ItemMergePlanTests + the web
 * merge-sku-dialog defaults).
 */
class ItemMergePlanTest {

    private fun current(vararg pairs: Pair<Field, String?>) =
        pairs.associate { (f, v) -> f to Value.text(v) }

    @Test
    fun agreeingFieldsAreNotConflicts() {
        val c = ItemMergePlan.conflicts(
            current(Field.TITLE to "Vintage Tee", Field.BRAND to "Nike"),
            current(Field.TITLE to "vintage tee", Field.BRAND to "Nike"),
        )
        // Case-insensitive: "Vintage Tee" and "vintage tee" are the same title.
        assertTrue(c.isEmpty())
    }

    @Test
    fun bothBlankIsNotAConflict() {
        val c = ItemMergePlan.conflicts(
            current(Field.BRAND to ""),
            current(Field.BRAND to null),
        )
        assertTrue(c.isEmpty())
    }

    @Test
    fun differingValuesConflict_andAreMarkedBothFilled() {
        val c = ItemMergePlan.conflicts(
            current(Field.BRAND to "Nike"),
            current(Field.BRAND to "Adidas"),
        )
        assertEquals(1, c.size)
        assertEquals(Field.BRAND, c[0].field)
        assertTrue(c[0].bothFilled)
        assertEquals("Nike", c[0].current.display)
        assertEquals("Adidas", c[0].existing.display)
    }

    @Test
    fun aGapIsAConflictRow_butNotABothFilledOne() {
        val c = ItemMergePlan.conflicts(
            current(Field.SIZE to ""),
            current(Field.SIZE to "L"),
        )
        assertEquals(1, c.size)
        assertFalse(c[0].bothFilled)
    }

    @Test
    fun defaults_keepTypedValuesButFillBlanksFromTheExistingRow() {
        val conflicts = ItemMergePlan.conflicts(
            current(Field.BRAND to "Nike", Field.SIZE to "", Field.COLOR to "Red"),
            current(Field.BRAND to "Adidas", Field.SIZE to "L", Field.COLOR to ""),
        )
        val keepExisting = ItemMergePlan.defaultKeepExisting(conflicts)

        // Real conflict → the most recent edit (what the user just typed) wins.
        assertFalse(keepExisting.contains(Field.BRAND))
        // Form left it blank → fill from the existing record rather than blank it.
        assertTrue(keepExisting.contains(Field.SIZE))
        // Existing is blank → nothing to take; the typed value stands.
        assertFalse(keepExisting.contains(Field.COLOR))
    }

    @Test
    fun pricesCompareAsCents_soFormattingIsNotAConflict() {
        val c = ItemMergePlan.conflicts(
            mapOf(Field.ACQUIRED_PRICE to Value.money("12")),
            mapOf(Field.ACQUIRED_PRICE to Value.money("12.00")),
        )
        assertTrue(c.isEmpty())

        val real = ItemMergePlan.conflicts(
            mapOf(Field.ACQUIRED_PRICE to Value.money("12")),
            mapOf(Field.ACQUIRED_PRICE to Value.money("15.50")),
        )
        assertEquals(1, real.size)
        assertEquals("$12.00", real[0].current.display)
        assertEquals("$15.50", real[0].existing.display)
    }

    @Test
    fun conflictsComeBackInFieldDeclarationOrder() {
        val c = ItemMergePlan.conflicts(
            current(Field.DESCRIPTION to "n", Field.TITLE to "a", Field.BRAND to "b"),
            current(Field.DESCRIPTION to "m", Field.TITLE to "z", Field.BRAND to "y"),
        )
        assertEquals(listOf(Field.TITLE, Field.BRAND, Field.DESCRIPTION), c.map { it.field })
    }

    @Test
    fun duplicateSkuErrorIsRecognisedByConstraintThenByCode() {
        assertTrue(
            ItemMergePlan.isDuplicateSkuError(
                "23505",
                """duplicate key value violates unique constraint "idx_inventory_items_user_sku"""",
            ),
        )
        // Constraint name alone is enough, even without the code.
        assertTrue(
            ItemMergePlan.isDuplicateSkuError(null, "... idx_inventory_items_user_sku ..."),
        )
        // Generic fallback needs BOTH uniqueness and sku.
        assertTrue(ItemMergePlan.isDuplicateSkuError("23505", "duplicate key ... sku ..."))
        // A different unique index must NOT be treated as a SKU collision.
        assertFalse(
            ItemMergePlan.isDuplicateSkuError("23505", "duplicate key ... idx_items_user_barcode"),
        )
        // Not a uniqueness violation at all.
        assertFalse(ItemMergePlan.isDuplicateSkuError("23502", "null value in column sku"))
        assertFalse(ItemMergePlan.isDuplicateSkuError(null, null))
    }
}
