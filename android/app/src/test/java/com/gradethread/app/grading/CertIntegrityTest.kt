package com.gradethread.app.grading

import com.gradethread.app.R
import java.io.File

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1337: the certificate-integrity verdict, the review gate, and the factor
 * weights — the three places this screen can lie to a buyer.
 */
class CertIntegrityTest {

    // ── classify: fails closed ───────────────────────────────────────────

    @Test
    fun `only an explicit verified-and-true is a pass`() {
        assertEquals(
            CertVerification.Verified(signed = true),
            CertIntegrity.classify(
                CertVerifyResponse(status = "verified", verified = true, signed = true),
            ),
        )
        assertEquals(
            CertVerification.Verified(signed = false),
            CertIntegrity.classify(CertVerifyResponse(status = "verified", verified = true)),
        )
    }

    @Test
    fun `a verified status with a false flag does NOT pass`() {
        // The asymmetry is the point: calling a forgery authentic costs far
        // more than declining to vouch for a genuine certificate.
        assertEquals(
            CertVerification.Unverifiable,
            CertIntegrity.classify(CertVerifyResponse(status = "verified", verified = false)),
        )
    }

    @Test
    fun `a mismatch is reported as tampering, not as unavailable`() {
        assertEquals(
            CertVerification.Tampered,
            CertIntegrity.classify(CertVerifyResponse(status = "mismatch", verified = false)),
        )
    }

    @Test
    fun `an unrecognised status degrades rather than passing`() {
        assertEquals(
            CertVerification.Unverifiable,
            CertIntegrity.classify(CertVerifyResponse(status = "probably-fine", verified = true)),
        )
        assertEquals(CertVerification.Unverifiable, CertIntegrity.classify(CertVerifyResponse()))
    }

    @Test
    fun `isVerified is true for exactly one case`() {
        assertTrue(CertVerification.Verified(signed = false).isVerified)
        assertFalse(CertVerification.Tampered.isVerified)
        assertFalse(CertVerification.Unverifiable.isVerified)
        assertFalse(CertVerification.Unavailable.isVerified)
        assertFalse(CertVerification.Verifying.isVerified)
    }

    @Test
    fun `tamper copy tells the reader not to trust it`() {
        val display = CertIntegrity.display(CertVerification.Tampered)
        assertEquals(CertIntegrity.Tone.DANGER, display.tone)
        // US-2976: the copy is a resource now, so the WORDS are pinned in
        // strings.xml and this asserts the right resource is chosen. The
        // sentence itself is checked by the copy case below, which reads
        // strings.xml rather than a literal.
        assertEquals(R.string.cert_integrity_tampered_detail, display.detail)
        // Retrying a tamper verdict would only invite a second opinion on a
        // settled answer.
        assertFalse(display.retryable)
    }

    /**
     * US-2976: the tamper sentence still tells the reader not to trust it.
     *
     * Reads strings.xml rather than a Kotlin literal, because that is where the
     * words live now. A plain JUnit test cannot resolve a resource id, so this
     * asserts against the file - which is also the only version a translator
     * will ever edit.
     */
    @Test
    fun `the tamper sentence still says do not trust it`() {
        val xml = File("src/main/res/values/strings.xml").readText()
        val detail = Regex(
            """<string name="cert_integrity_tampered_detail">([^<]*)</string>""",
        ).find(xml)?.groupValues?.get(1)
        assertNotNull("the tamper detail string is gone from strings.xml", detail)
        assertTrue(
            "the tamper banner must tell the reader not to trust it: \"$detail\"",
            detail!!.contains("don", ignoreCase = true) && detail.contains("trust"),
        )
    }

    @Test
    fun `only an unreachable service offers a retry`() {
        assertTrue(CertIntegrity.display(CertVerification.Unavailable).retryable)
        assertFalse(CertIntegrity.display(CertVerification.Unverifiable).retryable)
    }

    // ── certificate id extraction ────────────────────────────────────────

    @Test
    fun `the id is pulled out of a certificate url`() {
        assertEquals(
            "abc-123",
            CertificateId.extract("https://gradethread.com/cert/abc-123"),
        )
    }

    @Test
    fun `query, fragment and trailing path are trimmed`() {
        assertEquals("abc", CertificateId.extract("https://gradethread.com/cert/abc?utm=x"))
        assertEquals("abc", CertificateId.extract("https://gradethread.com/cert/abc#panel"))
        assertEquals("abc", CertificateId.extract("https://gradethread.com/cert/abc/verify"))
    }

    @Test
    fun `a non-certificate url yields null rather than a bogus path`() {
        assertNull(CertificateId.extract("https://gradethread.com/dashboard"))
        assertNull(CertificateId.extract("https://gradethread.com/cert/"))
        assertNull(CertificateId.extract(null))
        assertNull(CertificateId.extract("   "))
    }

    // ── link resolution ──────────────────────────────────────────────────

    @Test
    fun `an explicit absolute url wins over the constructed one`() {
        assertEquals(
            "https://custom.example/cert/xyz",
            CertificateLink.resolve("https://custom.example/cert/xyz", "abc"),
        )
    }

    @Test
    fun `an explicit value without a scheme is not trusted as a link`() {
        // A bare path stored by an older writer would otherwise be handed to
        // the share sheet as if it were a URL.
        assertEquals(
            "https://gradethread.com/cert/abc",
            CertificateLink.resolve("/cert/abc", "abc"),
        )
    }

    @Test
    fun `with neither an explicit url nor an id there is no link`() {
        assertNull(CertificateLink.resolve(null, null))
        assertNull(CertificateLink.resolve("", "  "))
    }

    // ── the review gate (US-1209 / US-1409) ──────────────────────────────

    @Test
    fun `a low-confidence grade with no certificate is pending review`() {
        assertTrue(GradeScale.isPendingReview(certificateUrl = null, confidence = 0.60))
        assertTrue(GradeScale.isPendingReview(certificateUrl = "", confidence = 0.74))
    }

    @Test
    fun `a certificate overrides low confidence`() {
        // US-1409: a certificate is only ever attached to a FINALIZED grade, so
        // a human reviewer already approved this one. Re-deriving "pending"
        // from confidence would tell the seller to wait for a review that has
        // already happened, with the certificate sitting right there.
        assertFalse(
            GradeScale.isPendingReview("https://gradethread.com/cert/abc", confidence = 0.42),
        )
    }

    @Test
    fun `the certify floor is inclusive`() {
        assertFalse(GradeScale.requiresReview(GradeScale.REVIEW_CONFIDENCE_THRESHOLD))
        assertTrue(GradeScale.requiresReview(GradeScale.REVIEW_CONFIDENCE_THRESHOLD - 0.001))
        assertEquals(0.75, GradeScale.REVIEW_CONFIDENCE_THRESHOLD, 0.0)
    }

    @Test
    fun `the low confidence band is exactly the review band`() {
        assertEquals(R.string.grade_confidence_low, GradeScale.confidenceLabel(0.74))
        assertEquals(R.string.grade_confidence_medium, GradeScale.confidenceLabel(0.75))
        assertEquals(R.string.grade_confidence_medium, GradeScale.confidenceLabel(0.85))
        assertEquals(R.string.grade_confidence_high, GradeScale.confidenceLabel(0.86))
    }

    // ── factor weights ───────────────────────────────────────────────────

    @Test
    fun `the five factor weights sum to one and match the grading spec`() {
        // These label the bars that explain the overall score. If they drifted
        // from the server's weights the breakdown would explain a number that
        // wasn't arrived at this way.
        assertEquals(1.0, GradeFactor.entries.sumOf { it.weight }, 1e-9)
        assertEquals(0.30, GradeFactor.FABRIC_CONDITION.weight, 1e-9)
        assertEquals(0.25, GradeFactor.STRUCTURAL_INTEGRITY.weight, 1e-9)
        assertEquals(0.20, GradeFactor.COSMETIC_APPEARANCE.weight, 1e-9)
        assertEquals(0.15, GradeFactor.FUNCTIONAL_ELEMENTS.weight, 1e-9)
        assertEquals(0.10, GradeFactor.ODOR_CLEANLINESS.weight, 1e-9)
        assertEquals("30%", GradeFactor.FABRIC_CONDITION.weightLabel)
    }

    @Test
    fun `each factor reads its own score off the report`() {
        val report = GradeReportDto(
            fabricConditionScore = 1.0,
            structuralIntegrityScore = 2.0,
            cosmeticAppearanceScore = 3.0,
            functionalElementsScore = 4.0,
            odorCleanlinessScore = 5.0,
        )
        assertEquals(
            listOf(1.0, 2.0, 3.0, 4.0, 5.0),
            GradeFactor.entries.map { it.score(report) },
        )
    }

    @Test
    fun `the verify response decodes the edge's snake_case body`() {
        val decoded = gradingJson.decodeFromString(
            CertVerifyResponse.serializer(),
            """{"certificate_id":"abc","status":"verified","verified":true,"signed":true,
                "algorithm":"hmac-sha256","integrity_version":3,"content_hash":"deadbeef",
                "issued_at":"2026-07-21T00:00:00.123456Z"}""",
        )
        assertEquals("abc", decoded.certificateId)
        assertEquals(3, decoded.integrityVersion)
        // Fractional seconds survive because this stays a String — a strict
        // date parser rejects them outright.
        assertEquals("2026-07-21T00:00:00.123456Z", decoded.issuedAt)
        assertTrue(CertIntegrity.classify(decoded).isVerified)
    }
}
