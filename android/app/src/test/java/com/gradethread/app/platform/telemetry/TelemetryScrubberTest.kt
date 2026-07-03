package com.gradethread.app.platform.telemetry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** US-1308: the PII scrubber (iOS TelemetryScrubber, US-662/990/1178). */
class TelemetryScrubberTest {

    @Test
    fun redactsEmails() {
        assertEquals(
            "signed in as [redacted-email]",
            TelemetryScrubber.redact("signed in as seller@example.com"),
        )
    }

    @Test
    fun redactsBearerTokensAndKeyValues() {
        assertEquals(
            "auth Bearer [redacted]",
            TelemetryScrubber.redact("auth Bearer eyJhbGciOi.abc-123_z"),
        )
        assertEquals(
            """apikey="[redacted]"""",
            TelemetryScrubber.redact("""apikey="sk_live_abc123""""),
        )
        assertEquals(
            "refresh_token: [redacted]",
            TelemetryScrubber.redact("refresh_token: v2.abc.def"),
        )
    }

    @Test
    fun redactsSignedStorageUrlsAndUuids() {
        val url =
            "https://api.gradethread.com/storage/v1/object/sign/submission-images/u/p.jpg?token=xyz"
        assertEquals("fetch [redacted-storage-url]", TelemetryScrubber.redact("fetch $url"))
        assertEquals(
            "item [redacted-uuid] synced",
            TelemetryScrubber.redact("item 0f1e2d3c-4b5a-4978-8765-0123456789ab synced"),
        )
    }

    @Test
    fun composition_scrubsEverythingInOnePass() {
        val dirty = "user a@b.co Bearer tok.en item 11111111-2222-4333-8444-555555555555"
        val clean = TelemetryScrubber.redact(dirty)
        assertFalse(clean.contains("a@b.co"))
        assertFalse(clean.contains("tok.en"))
        assertFalse(clean.contains("1111"))
    }

    @Test
    fun sensitiveHeaders_matchCaseInsensitively() {
        assertTrue(TelemetryScrubber.isSensitiveHeaderName("Authorization"))
        assertTrue(TelemetryScrubber.isSensitiveHeaderName("APIKEY"))
        assertFalse(TelemetryScrubber.isSensitiveHeaderName("Content-Type"))
    }

    @Test
    fun propertyMaps_scrubNestedValuesAndDropSensitiveKeys() {
        val props = TelemetryScrubber.redactProperties(
            mapOf(
                "email" to "x@y.co",
                "authorization" to "Bearer abc",
                "nested" to mapOf("apikey" to "raw-value", "note" to "ok c@d.io"),
                "list" to listOf("e@f.gg", 42),
                "count" to 3,
            ),
        )
        assertEquals("[redacted-email]", props["email"])
        assertEquals("[redacted]", props["authorization"])
        @Suppress("UNCHECKED_CAST")
        val nested = props["nested"] as Map<String, Any?>
        assertEquals("[redacted]", nested["apikey"])
        assertEquals("ok [redacted-email]", nested["note"])
        assertEquals(listOf("[redacted-email]", 42), props["list"])
        assertEquals(3, props["count"])
    }
}
