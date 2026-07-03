package com.gradethread.app.platform

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * US-1301: the config-parsing rules mirrored from iOS AppConfig — empty
 * placeholders read as absent; base URLs must be https; required values throw
 * with a NAMED error so a misconfigured build is diagnosable from the crash.
 */
class ConfigValidationTest {

    // ── blankToNull: the "placeholder means absent" rule ──

    @Test
    fun blankToNull_treatsEmptyAndWhitespaceAsAbsent() {
        assertNull(ConfigValidation.blankToNull(null))
        assertNull(ConfigValidation.blankToNull(""))
        assertNull(ConfigValidation.blankToNull("   "))
        assertNull(ConfigValidation.blankToNull("\t\n"))
    }

    @Test
    fun blankToNull_trimsRealValues() {
        assertEquals("phc_abc", ConfigValidation.blankToNull("  phc_abc "))
    }

    // ── requireHttpsBaseUrl ──

    @Test
    fun httpsBaseUrl_acceptsAndNormalizes() {
        assertEquals(
            "https://api.gradethread.com",
            ConfigValidation.requireHttpsBaseUrl("SUPABASE_URL", "https://api.gradethread.com/"),
        )
    }

    @Test
    fun httpsBaseUrl_rejectsCleartext() {
        val err = assertThrows(IllegalStateException::class.java) {
            ConfigValidation.requireHttpsBaseUrl("EDGE_API_URL", "http://functions.gradethread.com")
        }
        // The error names the offending key — diagnosable from a crash log.
        check(err.message!!.contains("EDGE_API_URL"))
    }

    @Test
    fun httpsBaseUrl_rejectsMissingAndGarbage() {
        assertThrows(IllegalStateException::class.java) {
            ConfigValidation.requireHttpsBaseUrl("SUPABASE_URL", "")
        }
        assertThrows(IllegalStateException::class.java) {
            ConfigValidation.requireHttpsBaseUrl("SUPABASE_URL", "not a url")
        }
        assertThrows(IllegalStateException::class.java) {
            // Scheme-only / no host.
            ConfigValidation.requireHttpsBaseUrl("SUPABASE_URL", "https://")
        }
    }

    // ── requireNonBlank ──

    @Test
    fun requireNonBlank_throwsNamedErrorWhenMissing() {
        val err = assertThrows(IllegalStateException::class.java) {
            ConfigValidation.requireNonBlank("SUPABASE_ANON_KEY", " ")
        }
        check(err.message!!.contains("SUPABASE_ANON_KEY"))
        assertEquals("key", ConfigValidation.requireNonBlank("SUPABASE_ANON_KEY", "key"))
    }
}
