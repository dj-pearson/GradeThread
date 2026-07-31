package com.gradethread.app.ui.components

import com.gradethread.app.ui.theme.BrandPalette
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * US-1303: the status → label/tone mapping is shared across every list
 * surface; a drift here makes the same status look different per screen.
 */
class StatusStyleTest {

    @Test
    fun label_titleCasesSnakeCase() {
        assertEquals("To List", StatusStyle.label("to_list"))
        assertEquals("Sold", StatusStyle.label("sold"))
        assertEquals("Photographed", StatusStyle.label("photographed"))
        assertEquals("", StatusStyle.label(""))
    }

    // US-2368: label() is the FALLBACK now. The statuses the app actually ships
    // each have a resource, and a test that only exercised the title-caser would
    // pass while every badge in the app rendered untranslated English.
    @Test
    fun `every shipped status has a string resource, unknown ones fall back`() {
        val shipped = listOf(
            "sourced", "cataloged", "measured", "photographed", "comped", "drafted",
            "to_list", "listed", "active", "sold", "shipped", "completed",
            "returned", "archived",
        )
        shipped.forEach { assertNotNull(it, StatusStyle.labelRes(it)) }
        assertNull(StatusStyle.labelRes("a_status_that_shipped_ahead_of_its_string"))
    }

    @Test
    fun tone_mapsPipelinePhases() {
        assertEquals(BrandPalette.Emerald, StatusStyle.tone("sold"))
        assertEquals(BrandPalette.Emerald, StatusStyle.tone("shipped"))
        assertEquals(BrandPalette.Emerald, StatusStyle.tone("completed"))
        assertEquals(BrandPalette.Navy, StatusStyle.tone("listed"))
        assertEquals(BrandPalette.Navy, StatusStyle.tone("active"))
        assertEquals(BrandPalette.Amber, StatusStyle.tone("drafted"))
        assertEquals(BrandPalette.Red, StatusStyle.tone("returned"))
    }

    @Test
    fun tone_preListPhasesReadSteel() {
        val steel = StatusStyle.tone("sourced")
        assertEquals(steel, StatusStyle.tone("measured"))
        assertEquals(steel, StatusStyle.tone("photographed"))
    }
}
