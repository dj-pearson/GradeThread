package com.gradethread.app.grading

import com.gradethread.app.platform.net.EdgeApi
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-1337: calls the public certificate-integrity endpoint.
 *
 * NEVER throws. A missing id, a transport failure, a 404 (withheld or
 * non-public), a 5xx — all collapse to [CertVerification.Unavailable], so the
 * caller always has a concrete non-pass state to render. A thrown error that
 * some caller forgot to catch would leave the badge absent, and an absent
 * badge reads as "fine".
 */
@Singleton
class CertIntegrityService @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
) {

    companion object {
        fun verifyPath(certificateId: String) =
            "/api/content/public/certificates/$certificateId/verify"
    }

    suspend fun verify(certificateUrl: String?): CertVerification {
        val certId = CertificateId.extract(certificateUrl) ?: return CertVerification.Unavailable
        return runCatching {
            val raw = edge.getRaw(verifyPath(certId))
            CertIntegrity.classify(
                gradingJson.decodeFromString(CertVerifyResponse.serializer(), raw),
            )
        }.getOrElse { CertVerification.Unavailable }
    }
}
