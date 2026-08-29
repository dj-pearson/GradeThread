import CoreGraphics
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
        /// US-2890 writes this server-side: the clockwise quarter turns that
        /// would put the CARD upright in this frame.
        ///
        /// DECLARED HERE BECAUSE OF WHAT CODABLE DOES WITHOUT IT. Swift's
        /// synthesized encoder writes exactly the declared properties, and its
        /// decoder ignores keys it does not know. So a field iOS never mentions
        /// survives being read and is DELETED the moment iOS writes the row
        /// back - which `saveLines` does every time a seller drags a line, and
        /// which `writeCalibration` now does on every rotate. The value would
        /// disappear on the client that never uses it, and the intake pass that
        /// does use it would see an upright photo where the server had recorded
        /// a sideways one.
        ///
        /// iOS reads and preserves it. It does not act on it: auto-rotation is
        /// a server decision behind a server setting (US-2890 AC6).
        let uprightTurns: Int?

        init(
            v: Int,
            cardVersion: Int,
            ppi: Double,
            homography: [Double],
            lines: [String: StoredLine]?,
            uprightTurns: Int? = nil
        ) {
            self.v = v
            self.cardVersion = cardVersion
            self.ppi = ppi
            self.homography = homography
            self.lines = lines
            self.uprightTurns = uprightTurns
        }
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

    /// US-2889: the same calibration, describing the ROTATED pixels.
    ///
    /// `ppi` and `cardVersion` are untouched on purpose: a quarter turn is a
    /// rigid motion, so it changes no distance and the reading is exactly as
    /// good as it was. Only the two things expressed in pixels move - the
    /// homography and every stored endpoint - and both move by the same map the
    /// pixels themselves took, which is why nothing has to be re-detected.
    ///
    /// `w`/`h` are the PRE-rotation dimensions, because that is the space the
    /// stored geometry is written in.
    static func rotated(
        _ calibration: Calibration,
        turns: MeasureQuarterTurn.Quarter,
        w: Double,
        h: Double
    ) -> Calibration {
        guard turns != .none else { return calibration }
        let movedLines = calibration.lines.map { lines in
            lines.mapValues { line -> StoredLine in
                let e1 = MeasureQuarterTurn.rotatePoint(
                    CGPoint(x: line.e1[0], y: line.e1[1]), turns: turns, w: w, h: h
                )
                let e2 = MeasureQuarterTurn.rotatePoint(
                    CGPoint(x: line.e2[0], y: line.e2[1]), turns: turns, w: w, h: h
                )
                return StoredLine(
                    e1: [Double(e1.x), Double(e1.y)],
                    e2: [Double(e2.x), Double(e2.y)],
                    inches: line.inches,
                    label: line.label
                )
            }
        }
        return Calibration(
            v: calibration.v,
            cardVersion: calibration.cardVersion,
            ppi: calibration.ppi,
            homography: MeasureQuarterTurn.rotateHomography(
                calibration.homography, turns: turns, w: w, h: h
            ),
            lines: movedLines,
            // ZERO, not carried. The photo is upright now, so the recorded turn
            // is spent; leaving the old value would have the intake pass rotate
            // an already-upright photo a second time. Same rule as the server's
            // uprightCalibration.
            uprightTurns: 0
        )
    }

    /// The same calibration, describing pixels that have been uniformly scaled.
    ///
    /// NEEDED BECAUSE THE ROTATE ALSO RESIZES. `PhotoRotateService` sends the
    /// rotated image through `PhotoCompressor`, which calls
    /// `resize(_:maxLongEdge:)` - so a large photo comes back smaller and the
    /// bytes on the server are not the bytes that were turned. Carrying only
    /// the rotation would leave every endpoint out by exactly the compressor's
    /// scale factor: not off screen, not obviously wrong, just consistently
    /// short - which is the worst way for a measurement to be wrong.
    ///
    /// A scale is not a rigid motion, but it IS similar: it multiplies every
    /// distance by `s` and the homography absorbs that exactly, because H reads
    /// source pixels and a new pixel is `s` times an old one. So the inches
    /// come out unchanged, same as the turn.
    static func scaled(_ calibration: Calibration, by s: Double) -> Calibration {
        guard s.isFinite, s > 0, s != 1 else { return calibration }
        let inv = 1 / s
        // H' = H * diag(inv, inv, 1): map the new pixel back to the old one
        // first, then measure it the way we always did.
        let scaledH = MeasureQuarterTurn.matMul3(
            calibration.homography, [inv, 0, 0, 0, inv, 0, 0, 0, 1]
        )
        let movedLines = calibration.lines.map { lines in
            lines.mapValues { line in
                StoredLine(
                    e1: [line.e1[0] * s, line.e1[1] * s],
                    e2: [line.e2[0] * s, line.e2[1] * s],
                    inches: line.inches,
                    label: line.label
                )
            }
        }
        return Calibration(
            v: calibration.v,
            cardVersion: calibration.cardVersion,
            // ppi is per INCH of card against pixels, so it scales with them.
            ppi: calibration.ppi * s,
            homography: scaledH,
            lines: movedLines,
            uprightTurns: calibration.uprightTurns
        )
    }

    /// Write a whole calibration onto the photo row, or CLEAR it.
    ///
    /// Passing nil is the honest outcome for any edit that resamples the frame:
    /// a crop or a straighten leaves geometry that describes pixels which no
    /// longer exist, and clearing it makes the editor re-detect rather than
    /// draw lines in the wrong place. US-2888 made the same choice on the web.
    func writeCalibration(photoId: String, calibration: Calibration?) async throws {
        struct Patch: Encodable {
            let measure_calibration: Calibration?
        }
        try await SupabaseShared.client
            .from("item_photos")
            .update(Patch(measure_calibration: calibration))
            .eq("id", value: photoId)
            .execute()
    }

    /// Read the calibration currently stored on a photo, if any.
    func loadCalibration(photoId: String) async throws -> Calibration? {
        struct Row: Decodable {
            let measure_calibration: Calibration?
        }
        let rows: [Row] = try await SupabaseShared.client
            .from("item_photos")
            .select("measure_calibration")
            .eq("id", value: photoId)
            .limit(1)
            .execute()
            .value
        return rows.first?.measure_calibration
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
            lines: lines,
            // Carried, not dropped. See the note on the property.
            uprightTurns: calibration.uprightTurns
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
