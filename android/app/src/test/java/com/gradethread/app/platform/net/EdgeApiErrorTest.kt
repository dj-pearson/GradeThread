package com.gradethread.app.platform.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** US-1306: the (status, body) → typed-error mapping, mirroring iOS. */
class EdgeApiErrorTest {

    @Test
    fun discriminators_beatStatusCodes() {
        assertEquals(
            EdgeApiError.WorkspaceAccessRevoked,
            EdgeApiError.from(403, """{"error_code":"workspace_access_revoked"}"""),
        )
        assertEquals(
            EdgeApiError.EmailUnverified,
            EdgeApiError.from(403, """{"code":"email_unverified"}"""),
        )
        // Capability gates key on the discriminator regardless of status.
        assertTrue(
            EdgeApiError.from(501, """{"code":"feature_unavailable","error":"x"}""")
                is EdgeApiError.FeatureUnavailable,
        )
        assertTrue(
            EdgeApiError.from(501, """{"code":"reconnect_required","error":"reconnect"}""")
                is EdgeApiError.FeatureUnavailable,
        )
        assertEquals(
            EdgeApiError.OfferNotOpen,
            EdgeApiError.from(409, """{"code":"offer_not_open"}"""),
        )
    }

    @Test
    fun statusRanges_mapToTypedCases() {
        assertEquals(EdgeApiError.Unauthorized, EdgeApiError.from(401, ""))
        assertEquals(EdgeApiError.Unauthorized, EdgeApiError.from(403, "{}"))
        assertTrue(EdgeApiError.from(404, "{}") is EdgeApiError.NotFound)
        assertTrue(EdgeApiError.from(429, "{}") is EdgeApiError.RateLimited)
        assertTrue(EdgeApiError.from(422, "{}") is EdgeApiError.BadRequest)
        assertTrue(EdgeApiError.from(500, "{}") is EdgeApiError.ServerError)
        assertTrue(EdgeApiError.from(503, "{}") is EdgeApiError.ServerError)
    }

    @Test
    fun detail_prefersStructuredFieldsThenPreview() {
        val structured = EdgeApiError.from(400, """{"error":"nope","detail":"Too many photos"}""")
        assertEquals("Too many photos", (structured as EdgeApiError.BadRequest).detail)

        val fallback = EdgeApiError.from(400, "plain text failure")
        assertEquals("plain text failure", (fallback as EdgeApiError.BadRequest).detail)
    }

    @Test
    fun bodyPreview_capsAt240Chars() {
        val long = "x".repeat(500)
        val preview = EdgeApiError.bodyPreview(long)!!
        assertEquals(241, preview.length) // 240 + ellipsis
        assertTrue(preview.endsWith("…"))
        assertEquals(null, EdgeApiError.bodyPreview("   "))
    }

    @Test
    fun userMessages_areActionable() {
        assertTrue(EdgeApiError.EmailUnverified.userMessage().contains("confirm your email"))
        assertTrue(EdgeApiError.RateLimited(30).userMessage().contains("30s"))
        assertTrue(EdgeApiError.RateLimited().userMessage().contains("in a moment"))
    }

    // ── US-1335: `action: "upgrade"` beats the status ────────────────────

    @Test
    fun upgradeAction_on429_isNotAThrottleMessage() {
        // The monthly free-Snap cap. As a plain 429 this told a seller who had
        // used their whole month's allowance to "slow down" — advice that can
        // never come true.
        val body = """{"error":"You've used all 5 free Snap-to-Value checks this month.",
            "code":"SNAP_LIMIT_REACHED","action":"upgrade"}"""
        val error = EdgeApiError.from(429, body)
        assertTrue(error is EdgeApiError.UpgradeRequired)
        assertEquals("SNAP_LIMIT_REACHED", (error as EdgeApiError.UpgradeRequired).code)
        assertTrue(error.userMessage().contains("all 5 free"))
        assertTrue(error.isUpgradePrompt)
    }

    @Test
    fun upgradeAction_on403_isNotASessionExpiredMessage() {
        // AI enrichment turned off. As a plain 403 this told the user to sign
        // in again, which does nothing about a setting.
        val error = EdgeApiError.from(
            403,
            """{"error":"AI enrichment is turned off for your account.","action":"upgrade"}""",
        )
        assertTrue(error is EdgeApiError.UpgradeRequired)
        assertTrue(error.userMessage().contains("turned off"))
    }

    @Test
    fun upgradeAction_isNeverRetried() {
        // A plain 429 IS retried, so without this mapping a cap-reached snap
        // burned two more requests against the per-IP daily ceiling for
        // nothing.
        val capped = EdgeApiError.from(429, """{"error":"capped","action":"upgrade"}""")
        assertFalse(EdgeApi.shouldRetry(capped, "POST"))
        assertTrue(EdgeApi.shouldRetry(EdgeApiError.from(429, "{}"), "POST"))
    }

    @Test
    fun moreSpecificDiscriminatorsStillWin() {
        // A revoked workspace must recover under the personal tenant, not show
        // an upsell, even if the body also carried an upgrade action.
        val error = EdgeApiError.from(
            403,
            """{"code":"workspace_access_revoked","action":"upgrade"}""",
        )
        assertTrue(error is EdgeApiError.WorkspaceAccessRevoked)
    }
}
