import Foundation

/// US-1294: calls the public certificate-integrity endpoint and resolves a
/// render-ready ``CertVerification``. Mirrors the web certificate page, which
/// fetches `/api/content/public/certificates/:id/verify` and renders the verdict.
///
/// NEVER throws — a missing certificate id, a transport failure, a 404
/// (withheld/flagged), or a 5xx all collapse to `.unavailable`, so the caller
/// always has a concrete non-pass state to show instead of a silent success.
enum CertIntegrityService {
    /// Verifies the certificate behind a public certificate URL (`<site>/cert/<id>`).
    static func verify(certificateURL: String, api: EdgeAPI = .shared) async -> CertVerification {
        guard let certId = CertificateID.extract(fromCertificateURL: certificateURL),
              let encoded = certId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              !encoded.isEmpty else {
            return .unavailable
        }
        do {
            let response: CertVerifyResponse = try await api.getJSON(
                "/api/content/public/certificates/\(encoded)/verify"
            )
            return CertIntegrity.classify(response)
        } catch {
            // Offline / 404 (withheld or non-public) / 5xx — fail closed.
            return .unavailable
        }
    }
}
