package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.passport.PassportActions
import com.gradethread.app.passport.PassportContent
import com.gradethread.app.passport.PassportEvent
import com.gradethread.app.passport.PassportEventPayload
import com.gradethread.app.passport.PassportHandoff
import com.gradethread.app.passport.PassportTimeline
import com.gradethread.app.passport.PassportVerifiedSeller
import com.gradethread.app.passport.PassportViewModel
import com.gradethread.app.ui.theme.GradeThreadTheme
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over a garment's chain of custody.
 *
 * ⚠ THREE STATES RENDER AS AN EMPTY SCREEN AND MEAN DIFFERENT THINGS:
 *
 *   loading      we are still asking
 *   noPassport   this item has never been graded, which is ORDINARY
 *   emptyChain   a passport exists and nothing has happened on it yet
 *
 * `noPassport` is deliberately not an error. Most of an inventory is ungraded,
 * so a red banner on the ordinary case would teach sellers to ignore banners.
 * All three are captured, because the only thing separating them is the words.
 *
 * ⚠ AND THE CLAIM LINK IS SHOWN EXACTLY ONCE. The server keeps a hash, so the
 * copy rendered on this screen is the only copy that will ever exist - it is
 * never written to DataStore, Room or SavedStateHandle. A golden of that
 * section is a golden of the one moment it is readable, which is also the one
 * moment a layout bug would hide it for good.
 *
 * ⚠ THE CHAIN MIXES ALL THREE CONFIDENCE LEVELS ON PURPOSE. `strength` is two
 * deterministic links out of four, which is exactly the "Moderate" band - a
 * fixture where every link matched would render the same as a calculation that
 * had stopped reading them.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class PassportScreenshotTest {

    private val skuClass = JsonObject(
        mapOf(
            "brand" to JsonPrimitive("Patagonia"),
            "garment_type" to JsonPrimitive("better_sweater"),
        ),
    )

    private val timeline = PassportTimeline(
        slug = "pat-bs-8f2a",
        skuClass = skuClass,
        status = "active",
        createdAt = "2026-05-02T10:00:00Z",
        originVerifiedSeller = PassportVerifiedSeller(
            handle = "threadandbone",
            displayName = "Thread & Bone",
            since = "2025-03-01",
        ),
        events = listOf(
            // ⚠ THE ENUM IS deterministic / probable / unknown, and anything
            // else reads as UNKNOWN by design - PassportConfidence.of sends
            // every unrecognised value to "Unverified" rather than guessing up.
            // The first version of this fixture used high/medium/low and got a
            // golden where all four links said Unverified and the chain scored
            // Emerging: a picture of the fallback, not of the feature.
            event("fingerprinted", "probable", "2026-05-02T10:05:00Z"),
            event("graded", "deterministic", "2026-05-02T10:30:00Z", score = 8.5, tier = "Excellent"),
            event("listed", "deterministic", "2026-05-04T09:00:00Z"),
            // Deliberately the weakest. `strength` divides deterministic links
            // by the total, so a chain of four identical links would render the
            // same as a calculation that had stopped reading them.
            event("ownership_transfer", "unknown", "2026-06-11T16:20:00Z"),
        ),
    )

    private val loaded = PassportViewModel.State(
        itemId = "i1",
        loaded = true,
        timeline = timeline,
        garmentId = "g1",
    )

    @Test
    fun chain_light() = capture("screen-passport-light") {
        PassportContent(loaded, PassportActions())
    }

    @Test
    fun chain_dark() = capture("screen-passport-dark", dark = true) {
        PassportContent(loaded, PassportActions())
    }

    /** Still asking. NOT "no passport". */
    @Test
    fun loading_light() = capture("screen-passport-loading-light") {
        PassportContent(
            PassportViewModel.State(itemId = "i1", loading = true),
            PassportActions(),
        )
    }

    /**
     * The ordinary case: this item was never graded. Must not read as a
     * failure, because most of an inventory looks like this.
     */
    @Test
    fun noPassport_light() = capture("screen-passport-none-light") {
        PassportContent(
            PassportViewModel.State(itemId = "i1", loaded = true, noPassport = true),
            PassportActions(),
        )
    }

    /** A passport exists and nothing has been recorded on it yet. */
    @Test
    fun emptyChain_light() = capture("screen-passport-emptychain-light") {
        PassportContent(
            loaded.copy(timeline = timeline.copy(events = emptyList())),
            PassportActions(),
        )
    }

    /** The claim link, in the one moment it is readable. */
    @Test
    fun claimLinkMinted_dark() = capture("screen-passport-claim-dark", dark = true) {
        PassportContent(
            loaded.copy(
                handoff = PassportHandoff(
                    token = "not-a-real-token-0000",
                    claimUrl = "https://gradethread.com/claim/not-a-real-token-0000",
                    expiresAt = "2026-09-06T10:00:00Z",
                ),
            ),
            PassportActions(),
        )
    }

    /** Minting failed. The section stays, the link does not appear. */
    @Test
    fun claimLinkFailed_dark() = capture("screen-passport-claim-error-dark", dark = true) {
        PassportContent(
            loaded.copy(handoffError = "Could not create a claim link."),
            PassportActions(),
        )
    }

    private fun event(type: String, confidence: String, at: String, score: Double? = null, tier: String? = null) =
        PassportEvent(
            eventType = type,
            confidence = confidence,
            actor = "threadandbone",
            source = "gradethread",
            payload = PassportEventPayload(overallScore = score, gradeTier = tier),
            createdAt = at,
        )

    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}
