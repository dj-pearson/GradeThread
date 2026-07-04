import Foundation

/// US-1575: client for the measurement endpoints (US-1572/73/77/80). The
/// server owns detection, extraction, overlay rendering, and telemetry — iOS
/// only calls and renders, which is what keeps all platforms' numbers
/// identical. Uses ``EdgeAPI/postForStatus`` so 422 quality-gate bodies
/// (card_not_found / photo_too_blurry / ...) surface their remediation text
/// VERBATIM instead of collapsing into a generic error.
@MainActor
final class MeasureService {
    private let edge: EdgeAPI

    init(edge: EdgeAPI = .aiShared) {
        self.edge = edge
    }

    // MARK: - Types (explicit keys; decoded bare — no key-conversion strategy)

    struct StoredLine: Codable, Equatable {
        let e1: [Double]
        let e2: [Double]
        let inches: Double
        let label: String
    }

    struct Calibration: Codable, Equatable {
        let v: Int
        let cardVersion: Int
        let ppi: Double
        let homography: [Double]
        let lines: [String: StoredLine]?
    }

    /// A quality-gate failure — `message` is the server's remediation string,
    /// shown verbatim with a Retake affordance.
    struct QualityFailure: Error, Equatable {
        let reason: String
        let message: String
    }

    struct ExtractedMeasurement: Decodable, Equatable {
        let key: String
        let label: String
        let inches: Double
        let confidence: Double
        let flagged: Bool
    }

    struct ExtractResult: Decodable {
        let measurements: [ExtractedMeasurement]
        let written: [String]
    }

    struct CorrectionDelta: Encodable {
        let key: String
        let proposed: Double
        let final: Double
        let confidence: Double?
        let flagged: Bool
    }

    private struct ErrorBody: Decodable {
        let error: String?
        let reason: String?
        let message: String?
    }

    // MARK: - Calls

    /// Detect the card + fit the homography. Throws ``QualityFailure`` with
    /// the server's remediation text on a 422; other failures throw EdgeAPIError.
    func calibrate(photoId: String, force: Bool = false) async throws -> Calibration {
        let body = try JSONSerialization.data(withJSONObject: [
            "photo_id": photoId,
            "force": force,
        ] as [String: Any])
        let (status, data) = try await edge.postForStatus(
            "/api/flipdesk/measure/calibrate", bodyData: body)
        if status == 422 {
            let err = (try? JSONDecoder().decode(ErrorBody.self, from: data))
            throw QualityFailure(
                reason: err?.reason ?? "quality",
                message: err?.message ?? err?.error ?? "The card could not be read — retake the photo."
            )
        }
        guard (200..<300).contains(status) else {
            throw EdgeAPIError.serverError(detail: Self.errorText(data))
        }
        return try JSONDecoder().decode(Calibration.self, from: data)
    }

    /// One billed AI action: propose + snap + convert every class measurement.
    func extract(photoId: String) async throws -> ExtractResult {
        let body = try JSONSerialization.data(withJSONObject: ["photo_id": photoId])
        let (status, data) = try await edge.postForStatus(
            "/api/flipdesk/measure/extract", bodyData: body)
        guard (200..<300).contains(status) else {
            throw EdgeAPIError.serverError(detail: Self.errorText(data))
        }
        return try JSONDecoder().decode(ExtractResult.self, from: data)
    }

    /// Regenerate the buyer-facing card-free measurements photo. Best-effort
    /// from the editor; failures are non-fatal.
    func regenerateOverlay(itemId: String) async {
        guard let body = try? JSONSerialization.data(withJSONObject: ["item_id": itemId]) else { return }
        _ = try? await edge.postForStatus(
            "/api/flipdesk/measure/overlay", bodyData: body)
    }

    /// US-1580 correction telemetry — deltas only; fire-and-forget.
    func recordCorrections(
        garmentClass: String,
        corrections: [CorrectionDelta]
    ) async {
        guard !corrections.isEmpty else { return }
        struct Payload: Encodable {
            let garment_class: String
            let corrections: [CorrectionDelta]
        }
        guard let body = try? JSONEncoder().encode(
            Payload(garment_class: garmentClass, corrections: corrections)) else { return }
        _ = try? await edge.postForStatus(
            "/api/flipdesk/measure/correction", bodyData: body)
    }

    /// Persist edited line geometry back onto the photo's calibration via the
    /// same additive `lines` field the web editor writes (RLS scopes the row
    /// to the signed-in owner; supabase-swift takes the Encodable directly).
    func saveLines(
        photoId: String,
        calibration: Calibration,
        lines: [String: StoredLine]
    ) async throws {
        struct Patch: Encodable {
            let measure_calibration: Calibration
        }
        let updated = Calibration(
            v: calibration.v,
            cardVersion: calibration.cardVersion,
            ppi: calibration.ppi,
            homography: calibration.homography,
            lines: lines
        )
        try await SupabaseShared.client
            .from("item_photos")
            .update(Patch(measure_calibration: updated))
            .eq("id", value: photoId)
            .execute()
    }

    private static func errorText(_ data: Data) -> String {
        (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
            ?? "Request failed"
    }
}
