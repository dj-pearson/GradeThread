import Foundation

/// US-2688 — the body `POST /api/grade/dispute` actually reads.
///
/// THE BUG THIS TYPE EXISTS TO STOP, because it was live and total: the request
/// struct lived inside `DisputeSheet.submit()` with a plain `gradeReportId`
/// property, and every EdgeAPI request is encoded by `JSONEncoder.iso8601`,
/// which sets `.convertToSnakeCase`. So iOS sent `grade_report_id`. The route
/// reads `body.gradeReportId` and has no snake_case fallback, so it answered
/// 400 "gradeReportId is required" — and the sheet renders the server's own
/// string, meaning the customer was shown a property name.
///
/// EVERY iOS dispute filing failed from 2026-08-17, when US-2670 routed them
/// through the edge, until this. Web and Android were unaffected: both hand-
/// build the JSON and neither transforms keys.
///
/// Hoisted out of the view and given explicit ``CodingKeys`` so the wire shape
/// is a thing a test can encode and read. `DisputeFilingTests` asserts the
/// literal bytes, because "the property is named right" is exactly the check
/// that passed while this was broken.
struct DisputeRequest: Encodable, Equatable {
    let gradeReportId: String
    let reason: String
    /// Base64 data-URI evidence photos. Omitted entirely when empty rather than
    /// sent as `[]` — the route treats a missing key and an empty array the
    /// same, and a text-only filing should not carry an empty field.
    let images: [String]?

    /// SPELLED OUT, and it must stay that way. `.convertToSnakeCase` rewrites
    /// any camelCase property name, and the route accepts exactly one spelling.
    enum CodingKeys: String, CodingKey {
        case gradeReportId = "gradeReportId"
        case reason
        case images
    }

    init(gradeReportId: String, reason: String, images: [String] = []) {
        self.gradeReportId = gradeReportId
        self.reason = reason
        self.images = images.isEmpty ? nil : images
    }

    /// Encoded exactly as ``EdgeAPI`` will encode it, so a test measures the
    /// real thing rather than a hand-rolled encoder that agrees with the code.
    func encodedForEdge() throws -> Data {
        try JSONEncoder.iso8601.encode(self)
    }
}
