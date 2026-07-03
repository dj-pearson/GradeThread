package com.gradethread.app.ui.a11y

import org.junit.Assert.assertEquals
import org.junit.Test

/** US-1304: the icon-scaling clamp math (iOS ScaledIconFont.resolve). */
class ScaledIconTest {

    @Test
    fun scalesWithFontScale() {
        assertEquals(20f, resolveScaledSize(20f, 1.0f, null))
        assertEquals(30f, resolveScaledSize(20f, 1.5f, null))
        assertEquals(40f, resolveScaledSize(20f, 2.0f, null))
    }

    @Test
    fun clampsAtMaxSoFixedFramesDontOverflow() {
        assertEquals(40f, resolveScaledSize(20f, 3.0f, 40f))
        // Under the cap the scale wins.
        assertEquals(24f, resolveScaledSize(20f, 1.2f, 40f))
    }

    @Test
    fun smallScalesShrinkWithoutAFloor() {
        assertEquals(17f, resolveScaledSize(20f, 0.85f, 40f))
    }
}
