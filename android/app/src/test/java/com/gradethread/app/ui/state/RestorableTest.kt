package com.gradethread.app.ui.state

import com.gradethread.app.inventory.InventoryStage
import com.gradethread.app.inventory.SortOption
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1390: the restoration rules.
 *
 * Every failure mode here is invisible until it happens on someone else's
 * device — an id that no longer exists, an enum a later build reordered, or a
 * selection big enough to blow the Binder budget and crash on rotate. So they
 * are decided in pure code and checked here.
 */
class RestorableTest {

    // ── Selection ────────────────────────────────────────────────────────────

    @Test
    fun `a huge selection is capped before it is saved`() {
        // Saved state crosses a Binder transaction with a shared ~1MB budget.
        // Exceeding it throws TransactionTooLargeException, which on rotation
        // is a CRASH, not a lost selection.
        val huge = (1..5_000).map { "item-$it" }.toSet()

        assertEquals(
            Restorable.MAX_SAVED_SELECTION,
            Restorable.saveableSelection(huge).split(Restorable.SELECTION_SEPARATOR).size,
        )
    }

    @Test
    fun `a small selection is saved whole`() {
        val small = setOf("a", "b", "c")
        assertEquals(3, Restorable.saveableSelection(small).split(",").size)
    }

    @Test
    fun `restoring drops ids that no longer exist`() {
        // A process death can be days later, and a sync in between may have
        // removed items. A selection carrying ghosts turns "delete 12" into a
        // request the server rejects halfway through.
        val restored = Restorable.restoreSelection(
            saved = "still-here,deleted-since,also-gone",
            presentIds = setOf("still-here", "never-selected"),
        )

        assertEquals(setOf("still-here"), restored)
    }

    @Test
    fun `nothing saved restores to nothing`() {
        assertTrue(Restorable.restoreSelection(null, setOf("a")).isEmpty())
        assertTrue(Restorable.restoreSelection("", setOf("a")).isEmpty())
    }

    @Test
    fun `every saved id being gone restores an empty selection, not a crash`() {
        assertTrue(
            Restorable.restoreSelection("gone-1,gone-2", setOf("other")).isEmpty(),
        )
    }

    // ── Enums ────────────────────────────────────────────────────────────────

    @Test
    fun `enums restore by name`() {
        assertEquals(
            InventoryStage.ACTIVE,
            Restorable.restoreEnum(InventoryStage.ACTIVE.name, InventoryStage.ALL),
        )
        assertEquals(
            SortOption.NEWEST,
            Restorable.restoreEnum(SortOption.NEWEST.name, SortOption.NEWEST),
        )
    }

    @Test
    fun `an unknown or missing name falls back rather than throwing`() {
        // A saved value from a NEWER build must not crash an older one, and a
        // renamed case must not resolve to whatever now sits at its ordinal.
        assertEquals(
            InventoryStage.ALL,
            Restorable.restoreEnum("A_STAGE_FROM_THE_FUTURE", InventoryStage.ALL),
        )
        assertEquals(InventoryStage.ALL, Restorable.restoreEnum(null, InventoryStage.ALL))
        assertEquals(InventoryStage.ALL, Restorable.restoreEnum("", InventoryStage.ALL))
    }

    @Test
    fun `a selection round-trips through the saved string`() {
        val ids = setOf("aaa", "bbb", "ccc")
        val present = setOf("aaa", "bbb", "ccc", "ddd")

        assertEquals(ids, Restorable.restoreSelection(Restorable.saveableSelection(ids), present))
    }

    @Test
    fun `an empty selection saves as an empty string, not as a blank id`() {
        assertEquals("", Restorable.saveableSelection(emptySet()))
        assertTrue(Restorable.restoreSelection("", setOf("a")).isEmpty())
    }

    @Test
    fun `saving by name is not the same as saving by position`() {
        // The point of the rule, stated as a test: position 1 of one enum is a
        // different value from position 1 of another, and an insert shifts both.
        val byName = Restorable.restoreEnum(InventoryStage.entries[1].name, InventoryStage.ALL)
        assertEquals(InventoryStage.entries[1], byName)
        assertEquals(InventoryStage.entries[1].name, byName.name)
    }

    // ── Routes ───────────────────────────────────────────────────────────────

    @Test
    fun `a route that no longer exists is not restored`() {
        // Restoring it into a graph with no such destination is a crash on
        // launch for anyone whose app was killed on that screen.
        val known = setOf("home", "inventory", "money")

        assertEquals("inventory", Restorable.restoreRoute("inventory", known))
        assertNull(Restorable.restoreRoute("removed-in-v3", known))
        assertNull(Restorable.restoreRoute(null, known))
    }

    // ── Fold / split-screen ──────────────────────────────────────────────────

    @Test
    fun `only a real compact to expanded crossing counts`() {
        // A foldable reports a width change on every hinge degree during the
        // animation; reacting to each one is what makes a fold stutter.
        assertTrue(Restorable.layoutChanged(wasCompact = true, isCompact = false))
        assertTrue(Restorable.layoutChanged(wasCompact = false, isCompact = true))
        assertFalse(Restorable.layoutChanged(wasCompact = true, isCompact = true))
        assertFalse(Restorable.layoutChanged(wasCompact = false, isCompact = false))
    }

    // ── Keys ─────────────────────────────────────────────────────────────────

    @Test
    fun `saved-state keys are unique`() {
        // rememberSaveable and SavedStateHandle both key by string, so two
        // screens sharing one would silently restore each other's state.
        val keys = listOf(
            Restorable.Keys.ADD_SHEET_OPEN,
            Restorable.Keys.INVENTORY_FILTERS_OPEN,
            Restorable.Keys.INVENTORY_SELECTION,
            Restorable.Keys.INVENTORY_STAGE,
            Restorable.Keys.INVENTORY_UNLISTED_FILTER,
            Restorable.Keys.INVENTORY_SORT,
            Restorable.Keys.INVENTORY_VIEW_MODE,
            Restorable.Keys.INVENTORY_QUERY,
            Restorable.Keys.SEARCH_QUERY,
        )

        assertEquals(keys.size, keys.toSet().size)
        assertTrue(keys.all { it.isNotBlank() })
    }
}
