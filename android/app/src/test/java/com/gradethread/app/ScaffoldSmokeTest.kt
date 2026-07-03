package com.gradethread.app

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * US-1300: proves the unit-test toolchain (JUnit4 + coroutines-test) runs.
 * Real behavior tests arrive with the first feature stories.
 */
class ScaffoldSmokeTest {
    @Test
    fun coroutinesTestHarness_works() = runTest {
        val flow = MutableStateFlow("scaffold")
        assertEquals("scaffold", flow.first())
    }
}
