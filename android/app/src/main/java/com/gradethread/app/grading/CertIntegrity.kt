package com.gradethread.app.grading

import androidx.annotation.StringRes
import com.gradethread.app.R

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * US-1337: certificate-integrity verification (iOS `CertIntegrity`, US-1294).
 *
 * Nothing is re-derived on the device. The public edge endpoint recomputes the
 * sealed content hash and checks the HMAC; this classifies its verdict. Pure,
 * so the fail-closed rule is provable with no network.
 */
@Serializable
data class CertVerifyResponse(
    @SerialName("certificate_id") val certificateId: String = "",
    /** "verified" | "mismatch" | "unverifiable" — the edge's own vocabulary. */
    val status: String = "",
    val verified: Boolean = false,
    val signed: Boolean = false,
    val algorithm: String = "",
    @SerialName("integrity_version") val integrityVersion: Int? = null,
    @SerialName("content_hash") val contentHash: String? = null,
    /**
     * Left as a String on purpose: the edge emits fractional-second ISO
     * timestamps that strict parsers reject, and this is only ever displayed.
     */
    @SerialName("issued_at") val issuedAt: String? = null,
)

/**
 * The rendered verdict. Transport failure collapses into the same set as the
 * endpoint's own statuses so a tampered OR unreachable certificate can never
 * be presented as a silent pass.
 */
sealed class CertVerification {
    object Verifying : CertVerification()
    data class Verified(val signed: Boolean) : CertVerification()

    /** The grade claims don't hash to the sealed value — tamper or forgery. */
    object Tampered : CertVerification()

    /** Legacy grade, finalized before the integrity scheme existed. */
    object Unverifiable : CertVerification()

    /** Offline, 404 (withheld / non-public), or 5xx. */
    object Unavailable : CertVerification()

    /** True ONLY for a confirmed pass. Everything else is a non-verified state. */
    val isVerified: Boolean get() = this is Verified
}

object CertIntegrity {

    /**
     * Map a response to a verdict. FAILS CLOSED.
     *
     * Only an explicit `status == "verified"` AND `verified == true` passes.
     * An explicit "mismatch" is tamper; everything else — including a response
     * that says "verified" while the boolean is false — degrades to
     * [CertVerification.Unverifiable]. The asymmetry is deliberate: the cost of
     * calling a forgery authentic is far higher than the cost of declining to
     * vouch for a genuine certificate.
     */
    fun classify(response: CertVerifyResponse): CertVerification = when {
        response.status == "verified" && response.verified ->
            CertVerification.Verified(signed = response.signed)

        response.status == "mismatch" -> CertVerification.Tampered

        else -> CertVerification.Unverifiable
    }

    /**
     * Render-ready copy for a verdict.
     *
     * US-2976: string RESOURCES. This banner is the one place the app says
     * whether a certificate can be TRUSTED, so a Spanish buyer reading
     * "Integrity check failed" in English is being shown the most important
     * sentence on the screen in a language they may not have.
     */
    fun display(verification: CertVerification): Display = when (verification) {
        CertVerification.Verifying -> Display(
            title = R.string.cert_integrity_verifying,
            detail = R.string.cert_integrity_verifying_detail,
            tone = Tone.NEUTRAL,
        )

        is CertVerification.Verified -> Display(
            title = R.string.cert_integrity_verified,
            detail = if (verification.signed) {
                R.string.cert_integrity_verified_signed_detail
            } else {
                R.string.cert_integrity_verified_detail
            },
            tone = Tone.VERIFIED,
        )

        CertVerification.Tampered -> Display(
            title = R.string.cert_integrity_tampered,
            detail = R.string.cert_integrity_tampered_detail,
            tone = Tone.DANGER,
        )

        CertVerification.Unverifiable -> Display(
            title = R.string.cert_integrity_unverifiable,
            detail = R.string.cert_integrity_unverifiable_detail,
            tone = Tone.WARNING,
        )

        CertVerification.Unavailable -> Display(
            title = R.string.cert_integrity_unavailable,
            detail = R.string.cert_integrity_unavailable_detail,
            tone = Tone.WARNING,
            retryable = true,
        )
    }

    enum class Tone { VERIFIED, DANGER, WARNING, NEUTRAL }

    data class Display(
        @StringRes val title: Int,
        @StringRes val detail: Int,
        val tone: Tone,
        val retryable: Boolean = false,
    )
}

/** Pulls the id out of a public certificate URL (`<site>/cert/<id>`). */
object CertificateId {

    fun extract(certificateUrl: String?): String? {
        val raw = certificateUrl?.trim().orEmpty()
        if (raw.isEmpty()) return null
        val marker = raw.indexOf(MARKER)
        if (marker < 0) return null
        var rest = raw.substring(marker + MARKER.length)
        // Stop at the first delimiter — a UUID never contains one, so the id is
        // whatever precedes it.
        val end = rest.indexOfFirst { it == '?' || it == '#' || it == '/' }
        if (end >= 0) rest = rest.substring(0, end)
        return rest.ifEmpty { null }
    }

    private const val MARKER = "/cert/"
}
