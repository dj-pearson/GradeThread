package com.gradethread.app.ui.components

import com.gradethread.app.ui.theme.BrandPalette
import org.junit.Assert.assertEquals
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
