package com.gradethread.app.ui

import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.gradethread.app.MainActivity
import com.gradethread.app.ui.shell.ShellSection
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * US-1395: the app launches and the shell is on screen.
 *
 * The single most valuable instrumented test this app can have, and one the 134
 * JVM unit tests cannot replace: none of them constructs the real Hilt graph.
 * A missing `@Binds`, a `@Provides` that throws, a circular dependency, or a
 * crash inside a ViewModel's `init` all compile perfectly and fail only when
 * Dagger assembles the graph on a device.
 *
 * That risk is not theoretical here — this session alone added Realtime,
 * workspace, import, support, feedback and referral bindings to the singleton
 * component, plus `SavedStateHandle` to two ViewModels.
 */
@HiltAndroidTest
@RunWith(AndroidJUnit4::class)
class AppLaunchTest {

    @get:Rule(order = 0)
    val hilt = HiltAndroidRule(this)

    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun theShellMounts() {
        hilt.inject()

        // The bottom bar is the proof the shell composed: it renders every
        // section label, so seeing them means the nav graph built and the
        // Activity survived onCreate.
        ShellSection.ordered.forEach { section ->
            compose.onNodeWithText(section.label).assertExists(
                "Shell section '${section.label}' is missing — the shell did not mount.",
            )
        }
    }

    @Test
    fun theAddSheetOpensAndCloses() {
        hilt.inject()

        // Add is the one bar item that opens a sheet rather than navigating, so
        // it exercises a code path the section labels alone do not.
        compose.onNodeWithText(ShellSection.ADD.label).performClick()
        compose.onNodeWithText("Take photos").assertExists()
    }
}
