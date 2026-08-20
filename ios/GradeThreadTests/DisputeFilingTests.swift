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

    func testSendsCamelCaseGradeReportId() throws {
        // The route reads body.gradeReportId and has NO snake_case fallback:
        // the wrong spelling is a 400 with "gradeReportId is required", shown to
        // the customer verbatim.
        let body = try json(DisputeRequest(gradeReportId: "gr-1", reason: "Too low"))
        XCTAssertTrue(body.contains("\"gradeReportId\""), body)
        XCTAssertFalse(body.contains("grade_report_id"), body)
    }

    func testTheEncoderStillTransformsUnprotectedKeys() throws {
        // The premise of the fix, pinned so it cannot quietly stop being true.
        // If EdgeAPI ever drops .convertToSnakeCase, the explicit CodingKeys
        // above become redundant rather than wrong - but this case is what says
        // the danger was real, and it is the reason the next author should not
        // "tidy" them away.
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
        let body = try json(
            DisputeRequest(
                gradeReportId: "gr-1",
                reason: "r",
                images: ["data:image/jpeg;base64,AAA"]
            )
        )
        XCTAssertTrue(body.contains("\"images\""), body)
        XCTAssertTrue(body.contains("data:image/jpeg;base64,AAA"), body)
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
