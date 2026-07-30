package com.gradethread.app.marketplaces.publish

import com.gradethread.app.platform.net.EdgeApiError
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1352: the publish state machine and the error→outcome mapping.
 *
 * These decide whether the Publish button is live, so they are tested rather
 * than trusted: a wrong branch either blocks a publishable item or, worse, lets
 * a blocked one through to eBay.
 */
class PublishFlowTest {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private fun summary(title: String = "Nice jacket") = PublishSummary(title = title)

    // ── validate ─────────────────────────────────────────────────────────────

    @Test
    fun `a clean pre-flight becomes a publishable review`() {
        val phase = PublishFlow.afterValidate(
            PublishOutcome.Validated(ValidateResponse(ok = true, summary = summary())),
        )
        assertTrue(phase is PublishPhase.Review && phase.publishable)
        assertTrue(PublishFlow.canPublish(phase))
    }

    @Test
    fun `blockers make the review unpublishable`() {
        val phase = PublishFlow.afterValidate(
            PublishOutcome.Validated(
                ValidateResponse(ok = false, blockers = listOf("Add at least one photo.")),
            ),
        )
        assertEquals(listOf("Add at least one photo."), (phase as PublishPhase.Review).blockers)
        assertFalse(PublishFlow.canPublish(phase))
    }

    @Test
    fun `warnings alone never block publishing`() {
        // A picture-standards nudge is advice. Treating it as a stop sign would
        // strand a listing that eBay would happily accept.
        val phase = PublishFlow.afterValidate(
            PublishOutcome.Validated(
                ValidateResponse(ok = true, warnings = listOf("Hero photo is under 1600px.")),
            ),
        )
        assertTrue(PublishFlow.canPublish(phase))
    }

    @Test
    fun `a 422 during pre-flight is shown as blockers, not an error`() {
        val phase = PublishFlow.afterValidate(PublishOutcome.Blockers(listOf("Pick a category.")))
        assertTrue(phase is PublishPhase.Review)
        assertEquals(listOf("Pick a category."), (phase as PublishPhase.Review).blockers)
    }

    @Test
    fun `a plan wall is its own phase, not a generic failure`() {
        val phase = PublishFlow.afterValidate(PublishOutcome.PlanLimit("You're at 50 listings."))
        assertEquals(PublishPhase.PlanLimit("You're at 50 listings."), phase)
    }

    // ── push ─────────────────────────────────────────────────────────────────

    @Test
    fun `a successful push carries the listing url and ids`() {
        val response = PushResponse(
            ok = true,
            listingId = "l1",
            listingUrl = "https://www.ebay.com/itm/1",
            offerId = "of1",
            sku = "SKU1",
        )
        assertEquals(
            PublishPhase.Published(response),
            PublishFlow.afterPush(PublishOutcome.Pushed(response)),
        )
    }

    @Test
    fun `blockers on push send the seller back to review, not to a dead end`() {
        // Something changed between pre-flight and publish (a deleted photo, a
        // removed policy). It is fixable, so it must not read as a failure.
        val phase = PublishFlow.afterPush(PublishOutcome.Blockers(listOf("Add at least one photo.")))
        assertTrue(phase is PublishPhase.Review)
        assertFalse(PublishFlow.canPublish(phase))
    }

    @Test
    fun `a missing offer explains itself`() {
        assertEquals(
            PublishPhase.Failed(PublishFlow.NO_OFFER_MESSAGE),
            PublishFlow.afterPush(PublishOutcome.NoOfferId),
        )
    }

    @Test
    fun `only a clean review can publish`() {
        assertFalse(PublishFlow.canPublish(PublishPhase.Composing))
        assertFalse(PublishFlow.canPublish(PublishPhase.Validating))
        assertFalse(PublishFlow.canPublish(PublishPhase.Pushing))
        assertFalse(PublishFlow.canPublish(PublishPhase.Failed("nope")))
        assertTrue(PublishFlow.isBusy(PublishPhase.Validating))
        assertTrue(PublishFlow.isBusy(PublishPhase.Pushing))
        assertFalse(PublishFlow.isBusy(PublishPhase.Composing))
    }

    // ── error mapping ────────────────────────────────────────────────────────

    @Test
    fun `a 422 body yields every blocker, not a truncated preview`() {
        // The reason BadRequest carries the raw body: `detail` is capped at 240
        // chars, and a long blocker list would lose its tail silently.
        val blockers = (1..12).map { "Blocker number $it with a reasonably long sentence." }
        val body = """{"ok":false,"blockers":[${blockers.joinToString(",") { "\"$it\"" }}]}"""
        val outcome = EbayPublishService.outcome(EdgeApiError.from(422, body), json)
        assertEquals(blockers, (outcome as PublishOutcome.Blockers).blockers)
    }

    @Test
    fun `a 4xx that is not a blockers body falls back to its message`() {
        val outcome = EbayPublishService.outcome(
            EdgeApiError.from(400, """{"error":"inventory_item_id is required"}"""),
            json,
        )
        assertEquals(
            PublishOutcome.Failed("inventory_item_id is required"),
            outcome,
        )
    }

    @Test
    fun `a plan wall maps to PlanLimit with the server's own copy`() {
        val outcome = EbayPublishService.outcome(
            EdgeApiError.from(
                403,
                """{"error":"You're at your 50 active listings.","action":"upgrade"}""",
            ),
            json,
        )
        assertEquals(
            PublishOutcome.PlanLimit("You're at your 50 active listings."),
            outcome,
        )
    }

    @Test
    fun `an empty blockers array is not treated as blockers`() {
        // `{"blockers":[]}` says nothing is wrong, which cannot be the reason a
        // request failed — showing an empty "fix these" list would be a dead end.
        val outcome = EbayPublishService.outcome(
            EdgeApiError.from(400, """{"ok":false,"blockers":[]}"""),
            json,
        )
        assertTrue(outcome is PublishOutcome.Failed)
    }
}
