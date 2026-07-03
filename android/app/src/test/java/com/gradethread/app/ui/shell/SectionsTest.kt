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
    fun labels_areNonEmpty() {
        assertTrue(ShellSection.entries.all { it.label.isNotBlank() })
    }
}
