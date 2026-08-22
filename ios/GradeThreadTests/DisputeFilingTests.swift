import XCTest
@testable import GradeThread

/// US-2688. The wire shape of a dispute filing, asserted on the encoded BYTES.
///
/// This is the test whose absence let a total outage ship. The property was
/// named `gradeReportId`, every reviewer read `gradeReportId`, and the request
/// carried `grade_report_id` because `EdgeAPI` encodes with
/// `.convertToSnakeCase`. Nothing in Swift, in review, or in the edge's own
/// suite was looking at the string that actually left the phone.
final class DisputeFilingTests: XCTestCase {

    private func json(_ request: DisputeRequest) throws -> String {
        String(data: try request.encodedForEdge(), encoding: .utf8) ?? ""
    }

    func testTheWireKeyIsSnakeCaseAndTheRouteAcceptsThat() throws {
        // ⚠ THIS CASE ASSERTED THE OPPOSITE AND FAILED ON iOS CI, which is the
        // only reason the wrong fix did not ship. Explicit CodingKeys do NOT
        // protect a key from .convertToSnakeCase - Swift applies the strategy to
        // the CodingKey's stringValue, so `case gradeReportId = "gradeReportId"`
        // still went out as grade_report_id.
        //
        // There is no client-side spelling that survives the shared encoder, so
        // the route was changed to accept BOTH. This pins what the phone really
        // sends; src/test/dispute-filing-key-contract.test.ts pins that the
        // route still takes it.
        let body = try json(DisputeRequest(gradeReportId: "gr-1", reason: "Too low"))
        XCTAssertTrue(body.contains("\"grade_report_id\""), body)
    }

    func testTheEncoderTransformsEveryCamelCaseKey() throws {
        // The premise of the whole story. Every multi-word key on every EdgeAPI
        // request is rewritten, whether or not the type declares CodingKeys - so
        // any route reading camelCase is unreachable from this client until it
        // accepts the snake_case spelling too.
        struct Probe: Encodable { let someCamelKey = 1 }
        let encoded = String(
            data: try JSONEncoder.iso8601.encode(Probe()),
            encoding: .utf8
        ) ?? ""
        XCTAssertTrue(encoded.contains("some_camel_key"), encoded)
    }

    func testReasonIsSentPlain() throws {
        let body = try json(DisputeRequest(gradeReportId: "gr-1", reason: "Grade too low: sleeve"))
        XCTAssertTrue(body.contains("\"reason\""), body)
        XCTAssertTrue(body.contains("Grade too low: sleeve"), body)
    }

    func testEvidenceIsOmittedWhenThereIsNone() throws {
        // Not sent as [] - the route treats a missing key and an empty array the
        // same, and a text-only filing should not carry an empty field.
        let body = try json(DisputeRequest(gradeReportId: "gr-1", reason: "r"))
        XCTAssertFalse(body.contains("images"), body)
    }

    func testEvidenceIsSentUnderTheKeyTheRouteReads() throws {
        // `images` and `reason` are single words, so the strategy leaves them
        // alone - they were never at risk and are asserted because the pair is
        // the contract, not because it was in doubt.
        let data = try DisputeRequest(
            gradeReportId: "gr-1",
            reason: "r",
            images: ["data:image/jpeg;base64,AAA"]
        ).encodedForEdge()
        let body = String(data: data, encoding: .utf8) ?? ""

        // The KEY stays a bytes assertion. A renamed or re-cased key is the
        // failure this whole file exists to catch, and only the bytes show it.
        XCTAssertTrue(body.contains("\"images\""), body)

        // The VALUE is asserted after DECODING, not against the raw bytes.
        // JSONEncoder escapes the forward slashes in a data URI, so the body
        // carries `data:image\/jpeg;base64,AAA`. That is valid JSON and the
        // route's parser undoes it, but a substring search for the unescaped URI
        // fails against a body that is perfectly correct.
        //
        // It did fail, and it took the whole Build + test job with it. The case
        // was invisible from 19 Aug until now because the app did not compile,
        // so the suite never ran to report it.
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(object?["images"] as? [String], ["data:image/jpeg;base64,AAA"], body)
    }

    @MainActor
    func testEvidenceCapMatchesTheEdge() {
        // MAX_DISPUTE_EVIDENCE in routes/grade.ts. Over the cap the route 400s
        // the WHOLE filing, so a client that lets you attach nine loses the
        // reason text too.
        XCTAssertEqual(DisputeEvidence.maxPhotos, 8)
    }

    @MainActor
    func testEvidencePickingStopsAtTheCap() async {
        let result = await DisputeEvidence.photos(from: [], room: 0)
        XCTAssertTrue(result.photos.isEmpty)
        XCTAssertEqual(result.skipped, 0)
    }
}
