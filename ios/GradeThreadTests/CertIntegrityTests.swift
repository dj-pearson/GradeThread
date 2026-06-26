import XCTest
@testable import GradeThread

/// US-1294: the iOS twin of the web certificate `/verify` flow. Covers the pure
/// verdict classification, the fail-closed defaults, certificate-id extraction,
/// the wire-shape decode, and the rendered display copy/tone.
final class CertIntegrityTests: XCTestCase {

    // MARK: - classify

    func test_classify_verifiedSigned() {
        let r = response(status: "verified", verified: true, signed: true)
        XCTAssertEqual(CertIntegrity.classify(r), .verified(signed: true))
    }

    func test_classify_verifiedUnsigned() {
        let r = response(status: "verified", verified: true, signed: false)
        XCTAssertEqual(CertIntegrity.classify(r), .verified(signed: false))
    }

    func test_classify_mismatchIsTampered() {
        let r = response(status: "mismatch", verified: false, signed: true)
        XCTAssertEqual(CertIntegrity.classify(r), .tampered)
    }

    func test_classify_unverifiableLegacy() {
        let r = response(status: "unverifiable", verified: false, signed: false)
        XCTAssertEqual(CertIntegrity.classify(r), .unverifiable)
    }

    func test_classify_failsClosed_verifiedStatusButFlagFalse() {
        // A "verified" status with verified:false must NOT pass.
        let r = response(status: "verified", verified: false, signed: false)
        XCTAssertEqual(CertIntegrity.classify(r), .unverifiable)
    }

    func test_classify_unknownStatusFailsClosed() {
        let r = response(status: "garbage", verified: true, signed: true)
        XCTAssertEqual(CertIntegrity.classify(r), .unverifiable)
        XCTAssertFalse(CertIntegrity.classify(r).isVerified)
    }

    // MARK: - isVerified

    func test_isVerified_onlyForVerifiedCase() {
        XCTAssertTrue(CertVerification.verified(signed: false).isVerified)
        XCTAssertTrue(CertVerification.verified(signed: true).isVerified)
        XCTAssertFalse(CertVerification.tampered.isVerified)
        XCTAssertFalse(CertVerification.unverifiable.isVerified)
        XCTAssertFalse(CertVerification.unavailable.isVerified)
        XCTAssertFalse(CertVerification.verifying.isVerified)
    }

    // MARK: - CertificateID.extract

    func test_extract_plainCertURL() {
        XCTAssertEqual(
            CertificateID.extract(fromCertificateURL: "https://gradethread.com/cert/abc-123"),
            "abc-123")
    }

    func test_extract_stripsQuery() {
        XCTAssertEqual(
            CertificateID.extract(fromCertificateURL: "https://gradethread.com/cert/abc-123?s=qr"),
            "abc-123")
    }

    func test_extract_stripsTrailingPathAndFragment() {
        XCTAssertEqual(
            CertificateID.extract(fromCertificateURL: "https://gradethread.com/cert/abc-123/share"),
            "abc-123")
        XCTAssertEqual(
            CertificateID.extract(fromCertificateURL: "https://gradethread.com/cert/abc-123#top"),
            "abc-123")
    }

    func test_extract_nilForNonCertOrEmpty() {
        XCTAssertNil(CertificateID.extract(fromCertificateURL: nil))
        XCTAssertNil(CertificateID.extract(fromCertificateURL: ""))
        XCTAssertNil(CertificateID.extract(fromCertificateURL: "   "))
        XCTAssertNil(CertificateID.extract(fromCertificateURL: "https://gradethread.com/x"))
        // A trailing "/cert/" with no id yields nil rather than an empty id.
        XCTAssertNil(CertificateID.extract(fromCertificateURL: "https://gradethread.com/cert/"))
    }

    // MARK: - wire decode

    func test_decodesSnakeCaseResponse() throws {
        let json = """
        {
          "certificate_id": "abc-123",
          "status": "verified",
          "verified": true,
          "signed": true,
          "algorithm": "SHA-256 + HMAC-SHA256",
          "integrity_version": 2,
          "content_hash": "deadbeef",
          "issued_at": "2026-06-01T12:00:00.123456Z"
        }
        """
        let r = try decoder().decode(CertVerifyResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.certificateId, "abc-123")
        XCTAssertEqual(r.status, "verified")
        XCTAssertTrue(r.verified)
        XCTAssertTrue(r.signed)
        XCTAssertEqual(r.integrityVersion, 2)
        XCTAssertEqual(r.contentHash, "deadbeef")
        XCTAssertEqual(r.issuedAt, "2026-06-01T12:00:00.123456Z")
        XCTAssertEqual(CertIntegrity.classify(r), .verified(signed: true))
    }

    func test_decodesLegacyResponseWithNulls() throws {
        let json = """
        {
          "certificate_id": "old-1",
          "status": "unverifiable",
          "verified": false,
          "signed": false,
          "algorithm": "SHA-256",
          "integrity_version": null,
          "content_hash": null,
          "issued_at": null
        }
        """
        let r = try decoder().decode(CertVerifyResponse.self, from: Data(json.utf8))
        XCTAssertNil(r.integrityVersion)
        XCTAssertNil(r.contentHash)
        XCTAssertNil(r.issuedAt)
        XCTAssertEqual(CertIntegrity.classify(r), .unverifiable)
    }

    // MARK: - display

    func test_display_eachCaseHasCopy() {
        for v: CertVerification in [.verifying, .verified(signed: true), .verified(signed: false),
                                    .tampered, .unverifiable, .unavailable] {
            XCTAssertFalse(v.display.title.isEmpty, "\(v) missing title")
            XCTAssertFalse(v.display.detail.isEmpty, "\(v) missing detail")
            XCTAssertFalse(v.display.systemImage.isEmpty, "\(v) missing glyph")
        }
    }

    func test_display_tones() {
        XCTAssertEqual(CertVerification.verified(signed: true).display.tone, .verified)
        XCTAssertEqual(CertVerification.tampered.display.tone, .danger)
        XCTAssertEqual(CertVerification.unverifiable.display.tone, .warning)
        XCTAssertEqual(CertVerification.unavailable.display.tone, .warning)
        XCTAssertEqual(CertVerification.verifying.display.tone, .neutral)
    }

    func test_display_onlyUnavailableIsRetryable() {
        XCTAssertTrue(CertVerification.unavailable.display.retryable)
        XCTAssertFalse(CertVerification.tampered.display.retryable)
        XCTAssertFalse(CertVerification.unverifiable.display.retryable)
        XCTAssertFalse(CertVerification.verified(signed: true).display.retryable)
    }

    // MARK: - helpers

    private func response(status: String, verified: Bool, signed: Bool) -> CertVerifyResponse {
        CertVerifyResponse(
            certificateId: "abc-123",
            status: status,
            verified: verified,
            signed: signed,
            algorithm: signed ? "SHA-256 + HMAC-SHA256" : "SHA-256",
            integrityVersion: 2,
            contentHash: "deadbeef",
            issuedAt: "2026-06-01T12:00:00Z")
    }

    private func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }
}
