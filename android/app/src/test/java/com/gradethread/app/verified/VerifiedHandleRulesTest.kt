package com.gradethread.app.verified

import com.gradethread.app.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * US-2493: the handle rules, mirrored from the server.
 *
 * This copy exists so a seller reads WHY a handle is refused while they type
 * instead of after a round trip. That only works if it refuses exactly what the
 * server refuses — `parseHandle` in `services/edge-functions/src/routes/verified.ts`,
 * itself mirroring the CHECK constraint from migration 00057. A local rule that
 * is too loose sends a doomed save; one that is too tight blocks a handle the
 * seller could have had, and neither is visible without this.
 */
class VerifiedHandleRulesTest {

    @Test
    fun `a plain handle passes`() {
        assertNull(VerifiedHandleRules.shapeError("thriftbird"))
        assertNull(VerifiedHandleRules.shapeError("thrift-bird-92"))
        assertNull(VerifiedHandleRules.shapeError("a1b"))
    }

    @Test
    fun `case and surrounding space are normalized, not refused`() {
        // The server lowercases and trims before validating, so refusing these
        // would reject a handle it would have accepted.
        assertEquals("thriftbird", VerifiedHandleRules.normalize("  ThriftBird "))
        assertNull(VerifiedHandleRules.shapeError("  ThriftBird "))
    }

    @Test
    fun `length is 3 to 30`() {
        assertEquals(R.string.verified_handle_length, VerifiedHandleRules.shapeError("ab"))
        assertEquals(R.string.verified_handle_length, VerifiedHandleRules.shapeError("a".repeat(31)))
        assertNull(VerifiedHandleRules.shapeError("a".repeat(30)))
    }

    @Test
    fun `a hyphen cannot lead or trail`() {
        assertEquals(R.string.verified_handle_charset, VerifiedHandleRules.shapeError("-thrift"))
        assertEquals(R.string.verified_handle_charset, VerifiedHandleRules.shapeError("thrift-"))
        assertNull(VerifiedHandleRules.shapeError("thr-ift"))
    }

    @Test
    fun `anything outside lowercase alphanumeric and hyphen is refused`() {
        for (bad in listOf("thrift_bird", "thrift.bird", "thrift bird", "thrift@bird", "thrïft")) {
            assertEquals(bad, R.string.verified_handle_charset, VerifiedHandleRules.shapeError(bad))
        }
    }

    @Test
    fun `reserved handles are refused with their own reason`() {
        // These would collide with a real route or impersonate the platform, so
        // "reserved" is a different answer from "taken" and reads differently.
        for (reserved in listOf("admin", "api", "gradethread", "verified", "support", "www")) {
            assertEquals(
                reserved,
                R.string.verified_handle_reserved,
                VerifiedHandleRules.shapeError(reserved),
            )
        }
        // Case-insensitively, because normalize runs first.
        assertEquals(
            R.string.verified_handle_reserved,
            VerifiedHandleRules.shapeError("GradeThread"),
        )
    }

    @Test
    fun `shape is checked before reserved`() {
        // "www" is reserved AND valid in shape; a two-character reserved word
        // would be a length problem first, and saying "reserved" about it would
        // send the seller looking for a different word rather than a longer one.
        assertEquals(R.string.verified_handle_length, VerifiedHandleRules.shapeError("og"))
    }
}
