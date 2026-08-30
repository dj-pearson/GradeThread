package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.settings.AccountDeletionService
import com.gradethread.app.settings.AccountProfile
import com.gradethread.app.settings.SettingsActions
import com.gradethread.app.settings.SettingsContent
import com.gradethread.app.settings.SettingsViewModel
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over the settings list.
 *
 * ⚠ A MISSING PLAN IS NOT THE FREE PLAN. When the profile fails to load, the
 * plan section has to say it does not know - telling a paying seller they are
 * on Free because a request failed is a worse lie than admitting the failure.
 * The loading, unavailable and loaded cases are all captured.
 *
 * ⚠ AND THE DELETE DIALOG IS GATED ON AN EXACT PHRASE. The button stays dead
 * until the typed text matches, and the password field only appears after the
 * SERVER asks for one - never guessed. Both halves are captured, because a
 * dialog that enabled the button early is a deleted account.
 *
 * ⚠ THE WORKSPACE SWITCHER IS ABSENT FROM THESE PIXELS, not broken. It resolves
 * its own Hilt ViewModel, so the goldens pass an empty slot; a switcher
 * regression is not something this file can catch.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class SettingsScreenshotTest {

    private val profile = AccountProfile(
        id = "u1",
        email = "sam@example.invalid",
        fullName = "Sam Ortega",
        plan = "pro",
        creditBalance = 42,
        gradesUsedThisMonth = 18,
    )

    private val loaded = SettingsViewModel.State(
        email = "sam@example.invalid",
        profile = profile,
        showCostOnRows = true,
        hapticsEnabled = true,
        analyticsEnabled = true,
    )

    private fun content(state: SettingsViewModel.State) = @Composable {
        SettingsContent(state, SettingsActions(), workspaceSwitcher = {})
    }

    @Test
    fun loaded_light() = capture("screen-settings-light", content = content(loaded))

    @Test
    fun loaded_dark() = capture("screen-settings-dark", dark = true, content = content(loaded))

    /** The plan is still on its way. */
    @Test
    fun planLoading_light() = capture(
        "screen-settings-plan-loading-light",
        content = content(
            SettingsViewModel.State(
                email = "sam@example.invalid",
                loadingProfile = true,
            ),
        ),
    )

    /**
     * The profile request failed. The plan reads as unavailable, NOT as Free -
     * compare with the loaded capture.
     */
    @Test
    fun planUnavailable_light() = capture(
        "screen-settings-plan-unavailable-light",
        content = content(SettingsViewModel.State(email = "sam@example.invalid")),
    )

    /** The export is being built. The row says so and stops taking taps. */
    @Test
    fun exporting_light() = capture(
        "screen-settings-exporting-light",
        content = content(loaded.copy(exporting = true)),
    )

    /** The export failed. */
    @Test
    fun exportError_light() = capture(
        "screen-settings-export-error-light",
        content = content(loaded.copy(exportError = "Could not build your export.")),
    )

    /** Something worth saying, dismissable. */
    @Test
    fun notice_light() = capture(
        "screen-settings-notice-light",
        content = content(loaded.copy(notice = "Check your email for a reset link.")),
    )

    /** Signing out. What it costs is spelled out. */
    @Test
    fun signOutConfirm_light() = capture(
        "screen-settings-signout-light",
        content = content(loaded.copy(pendingConfirm = SettingsViewModel.Confirm.SIGN_OUT)),
    )

    /** The delete dialog, nothing typed. The button is dead. */
    @Test
    fun deleteUntyped_light() = capture(
        "screen-settings-delete-light",
        content = content(loaded.copy(pendingConfirm = SettingsViewModel.Confirm.DELETE_ACCOUNT)),
    )

    /**
     * The phrase matches exactly and the server has asked for a password. Only
     * now is the button live.
     */
    @Test
    fun deleteArmed_dark() = capture(
        "screen-settings-delete-armed-dark",
        dark = true,
        content = content(
            loaded.copy(
                pendingConfirm = SettingsViewModel.Confirm.DELETE_ACCOUNT,
                deleteConfirmText = AccountDeletionService.CONFIRM_PHRASE,
                deletePasswordRequired = true,
                deletePassword = "hunter-not-a-real-password",
            ),
        ),
    )

    /** The deletion was refused. */
    @Test
    fun deleteError_light() = capture(
        "screen-settings-delete-error-light",
        content = content(
            loaded.copy(
                pendingConfirm = SettingsViewModel.Confirm.DELETE_ACCOUNT,
                deleteConfirmText = AccountDeletionService.CONFIRM_PHRASE,
                deleteError = "That password did not match.",
            ),
        ),
    )

    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}
