package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.disclosure.DisclosureActions
import com.gradethread.app.disclosure.DisclosureContent
import com.gradethread.app.disclosure.DisclosureData
import com.gradethread.app.disclosure.DisclosureGrade
import com.gradethread.app.disclosure.DisclosurePhoto
import com.gradethread.app.disclosure.DisclosureText
import com.gradethread.app.disclosure.DisclosureViewModel
import com.gradethread.app.disclosure.PhotoAnnotation
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: a golden over the condition-disclosure screen.
 *
 * ⚠ THIS SCREEN HAS A PROPERTY NOTHING ELSE IN THE APP HAS. It decides what a
 * BUYER is told about a garment's flaws. A layout regression here does not cost
 * a seller a click - it changes what was disclosed, on the record, about an item
 * someone may already have bought. That is the argument for capturing it ahead
 * of the other 45 screens still waiting.
 *
 * ⚠ WHAT THESE CAPTURES DO NOT COVER, stated because the first draft of this
 * comment claimed otherwise. The PHOTO DOES NOT RENDER: Coil cannot load a
 * network URL under Robolectric, so the annotated image and its bbox overlay are
 * absent from every capture here. A defect that stopped being DRAWN on the photo
 * would not redden any of these.
 *
 * What they do cover is the half that reaches a buyer in words: the disclosure
 * text, the "2 noted" count, which photos are offered as annotatable, and which
 * actions are enabled. Both annotation kinds are still in the fixture -
 * PhotoAnnotation.isLocalized is true only when bbox has four numbers, and a
 * legend-only defect has no place on the photo to point at - so the COUNT covers
 * both, even though the drawing does not. Proving the overlay needs an
 * instrumented test with a local image, and that is not this.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class DisclosureScreenshotTest {

    private val photos = listOf(
        DisclosurePhoto(
            imageType = "detail",
            url = "https://example.invalid/detail-1.jpg",
            annotations = listOf(
                // Localized: has a place on the photo.
                PhotoAnnotation(
                    n = 1,
                    issue = "Small stain",
                    severity = "minor",
                    location = "Left cuff",
                    bbox = listOf(0.31, 0.42, 0.12, 0.09),
                ),
                // Legend-only: no bbox, so nothing to point at.
                PhotoAnnotation(
                    n = 2,
                    issue = "Persistent odor",
                    severity = "major",
                    location = "Throughout",
                ),
            ),
        ),
        // Carries no callouts, so it is not annotatable and must not offer to be.
        DisclosurePhoto(imageType = "front", url = "https://example.invalid/front.jpg"),
    )

    private val loaded = DisclosureViewModel.State(
        itemId = "i1",
        loading = false,
        data = DisclosureData(
            graded = true,
            grade = DisclosureGrade(
                overallScore = 6.5,
                gradeTier = "Good",
                certificateId = "GT-FIXTURE-0001",
            ),
            disclosure = DisclosureText(
                plain = "Light overall wear. One small mark at the left cuff and a " +
                    "persistent musty odor that did not lift with cleaning.",
                defectCount = 2,
                hasDefects = true,
            ),
            photos = photos,
        ),
    )

    @Test
    fun disclosure_light() = capture("screen-disclosure-light") {
        DisclosureContent(loaded, DisclosureActions())
    }

    @Test
    fun disclosure_dark() = capture("screen-disclosure-dark", dark = true) {
        DisclosureContent(loaded, DisclosureActions())
    }

    /**
     * A garment with nothing wrong with it. The screen must not imply a defect
     * that was never found - an empty disclosure is a claim too.
     */
    @Test
    fun noDefects_light() = capture("screen-disclosure-nodefects-light") {
        DisclosureContent(
            loaded.copy(
                data = loaded.data?.copy(
                    disclosure = DisclosureText(
                        plain = "No defects found.",
                        defectCount = 0,
                        hasDefects = false,
                    ),
                    photos = listOf(photos[1]),
                ),
            ),
            DisclosureActions(),
        )
    }

    /** Still loading. One boolean from the screen above. */
    @Test
    fun loading_light() = capture("screen-disclosure-loading-light") {
        DisclosureContent(DisclosureViewModel.State(itemId = "i1"), DisclosureActions())
    }

    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}
