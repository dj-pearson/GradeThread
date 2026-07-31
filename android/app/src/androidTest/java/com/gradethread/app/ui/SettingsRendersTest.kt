package com.gradethread.app.ui

import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.gradethread.app.MainActivity
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * US-1395: Settings renders, with every dependency it injects resolved.
 *
 * The strongest graph check after launch itself. `SettingsViewModel` alone pulls
 * in auth, the Supabase client, Room, push registration, the background-refresh
 * store, the onboarding store and the realtime service; the screen also hosts
 * `FeedbackViewModel` and `WorkspaceViewModel`. Any one of those failing to
 * construct compiles fine and blows up here.
 *
 * Deliberately asserts only what is true SIGNED OUT — the emulator has no
 * session, so anything gated on a user would be a flake, not a check.
 */
@HiltAndroidTest
@RunWith(AndroidJUnit4::class)
class SettingsRendersTest {

    @get:Rule(order = 0)
    val hilt = HiltAndroidRule(this)

    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun settingsOpensAndShowsItsSections() {
        hilt.inject()

        // By content description, not text: the toolbar entry is an icon, and
        // matching on "Settings" would also hit the screen's own title once it
        // is open.
        compose.onNodeWithContentDescription("Settings").performClick()

        // Section headers, not values: the values depend on a session the
        // emulator does not have.
        listOf("Account", "Preferences", "Help", "Diagnostics").forEach { header ->
            compose.onNodeWithText(header).performScrollTo().assertExists(
                "Settings section '$header' is missing.",
            )
        }
    }

    @Test
    fun theFeedbackSheetOpens() {
        hilt.inject()

        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithText("Send feedback").performScrollTo().performClick()

        // The sheet's own copy — proves FeedbackViewModel constructed and the
        // sheet composed, which is the part no JVM test can reach.
        compose.onNodeWithText("Something's broken").assertExists()
    }
}
