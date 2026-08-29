package com.gradethread.app.ui.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** US-1313: the shell registry + the adaptive nav decision. */
class SectionsTest {

    @Test
    fun registry_hasTheFiveSectionsWithAddCentered() {
        assertEquals(5, ShellSection.ordered.size)
        assertEquals(ShellSection.ADD, ShellSection.ordered[2])
        assertEquals(
            listOf("home", "inventory", "add", "money", "marketplaces"),
            ShellSection.ordered.map { it.route },
        )
    }

    @Test
    fun routes_areUnique() {
        val routes = ShellSection.entries.map { it.route } +
            listOf(ShellRoutes.SETTINGS, ShellRoutes.SEARCH, ShellRoutes.TOOLS)
        assertEquals(routes.size, routes.toSet().size)
    }

    @Test
    fun navKind_adaptsToWidth() {
        assertEquals(NavKind.BOTTOM_BAR, navKindForWidth(isCompactWidth = true))
        assertEquals(NavKind.RAIL, navKindForWidth(isCompactWidth = false))
    }

    @Test
    fun labels_areRealResourceIds() {
        // US-2976: these were String literals until 2026-08-28, so a Spanish
        // seller got Herramientas and Ajustes in the top bar with English
        // directly beneath them. `isNotBlank` was the old assertion and it
        // could not have failed on that - a hardcoded English string is not
        // blank. Zero is the id an unresolved resource reference carries.
        assertTrue(ShellSection.entries.all { it.label != 0 })
        assertTrue(ShellSection.entries.all { it.barLabel != 0 })
    }

    @Test
    fun onlyMarketplacesShortensItsBarLabel() {
        // A bar label that differs from the section's name is a deliberate
        // decision - it means the section is called one thing and shown as
        // another - and there should be exactly one, for the one label that
        // does not fit five-across on a compact phone. A second one appearing
        // silently is the drift this pins.
        val shortened = ShellSection.entries.filter { it.barLabel != it.label }
        assertEquals(listOf(ShellSection.MARKETPLACES), shortened)
    }
}
