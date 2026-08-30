package com.gradethread.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.capture.CaptureActions
import com.gradethread.app.capture.CaptureContent
import com.gradethread.app.capture.CapturePublishViewModel
import com.gradethread.app.capture.PhotoIntakeStore
import com.gradethread.app.capture.PhotoProfile
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over the photo-capture strip.
 *
 * ⚠ THE LIVE PREVIEW IS NOT CAPTURED, and that is deliberate. A CameraX
 * `PreviewView` needs a bound lifecycle and a device camera; a flat placeholder
 * stands in for it so the parts that CAN be wrong - which slots the strip
 * offers, which are already filled, whether the publish button is even there -
 * are the parts a golden holds still.
 *
 * ⚠ AND THE PUBLISH BUTTON IS CONDITIONAL. It appears only once every blocking
 * slot has a photo, so "no button" is the correct rendering of a half-shot
 * session rather than a missing control. Both are captured.
 *
 * ⚠ TWO BANNERS SHARE THE SAME SPOT and mean opposite things. The share-drain
 * notice reports photos that ARRIVED; the process-failed banner reports a shot
 * that did NOT survive. A seller who reads the second as the first thinks they
 * have a photo they do not have.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class CaptureScreenshotTest {

    private val profile = PhotoProfile.clothingFallback

    private fun store(vararg filled: String, active: String = "front") = PhotoIntakeStore(
        PhotoIntakeStore.State(
            photos = filled.associateWith { "/data/captures/$it.jpg" },
            activeSlot = active,
        ),
        profile,
    )

    private val idle = CapturePublishViewModel.State()

    /** Front shot taken, back still to go. No publish button yet. */
    @Test
    fun partway_light() = capture("screen-capture-light") {
        CaptureContent(store("front", active = "back"), idle, CaptureActions(), preview = stub())
    }

    @Test
    fun partway_dark() = capture("screen-capture-dark", dark = true) {
        CaptureContent(store("front", active = "back"), idle, CaptureActions(), preview = stub())
    }

    /** Nothing shot yet. The opening frame. */
    @Test
    fun empty_light() = capture("screen-capture-empty-light") {
        CaptureContent(store(), idle, CaptureActions(), preview = stub())
    }

    /**
     * Every blocking slot filled, so the publish button appears. Compare with
     * the partway capture, where it correctly does not.
     */
    @Test
    fun readyToPublish_light() = capture("screen-capture-ready-light") {
        CaptureContent(store("front", "back"), idle, CaptureActions(), preview = stub())
    }

    /** Publishing. The button says so and stops taking taps. */
    @Test
    fun publishing_light() = capture("screen-capture-publishing-light") {
        CaptureContent(
            store("front", "back"),
            CapturePublishViewModel.State(publishing = true),
            CaptureActions(),
            preview = stub(),
        )
    }

    /** Photos that arrived from another app's share sheet. */
    @Test
    fun shareNotice_light() = capture("screen-capture-share-notice-light") {
        CaptureContent(
            store("front"),
            idle,
            CaptureActions(),
            shareNotice = "Added 3 photos from Photos.",
            preview = stub(),
        )
    }

    /**
     * A shot that did not survive processing. Same spot as the share notice
     * above and the opposite news.
     */
    @Test
    fun captureError_light() = capture("screen-capture-error-light") {
        CaptureContent(
            store("front"),
            idle,
            CaptureActions(),
            captureError = true,
            preview = stub(),
        )
    }

    /** The publish failed. The reason sits above the button. */
    @Test
    fun publishError_dark() = capture("screen-capture-publish-error-dark", dark = true) {
        CaptureContent(
            store("front", "back"),
            CapturePublishViewModel.State(errorMessage = "Could not reach the server."),
            CaptureActions(),
            preview = stub(),
        )
    }

    /** A flat stand-in for the camera feed. */
    private fun stub(): @Composable () -> Unit = {
        Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceVariant))
    }

    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}
