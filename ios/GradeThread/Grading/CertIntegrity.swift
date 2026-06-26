import Foundation

/// US-1294: certificate-integrity verification — the iOS twin of the web
/// `/api/content/public/certificates/:id/verify` flow + the certificate page's
/// IntegrityPanel. Re-derives nothing client-side; it asks the public edge
/// endpoint (which recomputes the sealed content hash + checks the HMAC) and
/// renders the verdict so a seller/buyer can confirm a Digital Slab (US-763) is
/// authentic before trusting — or sharing — it.
///
/// Everything here is PURE (no networking) so it unit-tests with no env; the
/// network call lives in ``CertIntegrityService``.

/// Raw verify-endpoint response. Snake-case keys are mapped by the EdgeAPI
/// decoder (`.convertFromSnakeCase`). `issuedAt` stays a `String`: the edge
/// emits fractional-second ISO timestamps that the default `.iso8601` date
/// strategy REJECTS, and we only ever display it.
struct CertVerifyResponse: Decodable, Equatable {
    let certificateId: String
    /// "verified" | "mismatch" | "unverifiable" (matches edge `verifyCertIntegrity`).
    let status: String
    let verified: Bool
    let signed: Bool
    let algorithm: String
    let integrityVersion: Int?
    let contentHash: String?
    let issuedAt: String?
}

/// The resolved verdict the UI renders. Collapses the endpoint status PLUS any
/// transport/parse failure into one exhaustive set so a tampered OR unreachable
/// certificate can NEVER be presented as a silent pass (AC3).
enum CertVerification: Equatable {
    /// In-flight — the verify request hasn't resolved yet.
    case verifying
    /// Hash (and signature, when signed) matched the sealed record.
    case verified(signed: Bool)
    /// status "mismatch": grade claims don't hash to the sealed value (tamper/forgery).
    case tampered
    /// status "unverifiable": legacy grade finalized before the integrity scheme.
    case unverifiable
    /// Couldn't reach or parse the verify endpoint (offline, 404/withheld, 5xx).
    case unavailable
}

/// Pure helpers for the verification flow.
enum CertIntegrity {
    /// Maps the endpoint response → the rendered verdict. FAIL CLOSED: only an
    /// explicit `status == "verified"` AND `verified == true` is a pass; an
    /// explicit "mismatch" is tampered; everything else (including a stray
    /// `verified:false`) degrades to `.unverifiable` so nothing reads as authentic.
    static func classify(_ response: CertVerifyResponse) -> CertVerification {
        if response.status == "verified", response.verified {
            return .verified(signed: response.signed)
        }
        if response.status == "mismatch" {
            return .tampered
        }
        return .unverifiable
    }
}

/// Pulls the `<id>` out of a public certificate URL (`<site>/cert/<id>`,
/// optionally with a query/fragment). Returns nil for a non-certificate URL —
/// the caller then renders `.unavailable` rather than hitting a bogus path.
enum CertificateID {
    static func extract(fromCertificateURL url: String?) -> String? {
        guard let raw = url?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty,
              let range = raw.range(of: "/cert/") else { return nil }
        var rest = String(raw[range.upperBound...])
        // Stop at the first query/fragment/path delimiter — a UUID never
        // contains one, so the id is whatever precedes it.
        if let end = rest.firstIndex(where: { $0 == "?" || $0 == "#" || $0 == "/" }) {
            rest = String(rest[..<end])
        }
        return rest.isEmpty ? nil : rest
    }
}

/// Render-ready presentation for a verdict (copy + glyph + tone). Pure so the
/// badge view stays declarative and the copy is unit-testable.
struct CertVerificationDisplay: Equatable {
    enum Tone: Equatable { case verified, danger, warning, neutral }

    let title: String
    let detail: String
    let systemImage: String
    let tone: Tone
    /// True when offering a "Try again" affordance makes sense (transient failure).
    let retryable: Bool
}

extension CertVerification {
    var display: CertVerificationDisplay {
        switch self {
        case .verifying:
            return CertVerificationDisplay(
                title: "Verifying certificate…",
                detail: "Confirming this grade matches its sealed record.",
                systemImage: "shield.lefthalf.filled",
                tone: .neutral,
                retryable: false)
        case let .verified(signed):
            return CertVerificationDisplay(
                title: "Certificate verified",
                detail: signed
                    ? "Grade claims match the cryptographically signed record."
                    : "Grade claims match the sealed record.",
                systemImage: "checkmark.seal.fill",
                tone: .verified,
                retryable: false)
        case .tampered:
            return CertVerificationDisplay(
                title: "Integrity check failed",
                detail: "These grade claims don't match the sealed record — don't trust this certificate.",
                systemImage: "exclamationmark.octagon.fill",
                tone: .danger,
                retryable: false)
        case .unverifiable:
            return CertVerificationDisplay(
                title: "Integrity record unavailable",
                detail: "This grade predates tamper-proofing, so it can't be cryptographically verified.",
                systemImage: "questionmark.shield.fill",
                tone: .warning,
                retryable: false)
        case .unavailable:
            return CertVerificationDisplay(
                title: "Couldn't verify",
                detail: "We couldn't reach the verification service. Check your connection and try again.",
                systemImage: "wifi.exclamationmark",
                tone: .warning,
                retryable: true)
        }
    }

    /// True only for a confirmed pass — callers must treat every other case as
    /// a non-verified state (AC3: never a silent pass).
    var isVerified: Bool {
        if case .verified = self { return true }
        return false
    }
}
