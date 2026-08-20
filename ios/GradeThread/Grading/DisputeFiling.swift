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
/// ⚠ AND THE FIRST FIX FOR IT WAS WRONG, which the byte-level tests below
/// caught on iOS CI before anyone shipped it. Explicit ``CodingKeys`` do NOT
/// protect a key from the encoder's strategy: Swift applies
/// `.convertToSnakeCase` to the CodingKey's *stringValue*, so
/// `case gradeReportId = "gradeReportId"` still left as `grade_report_id`.
/// (`data_url` in the support composer survives only because it is ALREADY
/// snake_case - it has no uppercase for the strategy to act on.)
///
/// So the real fix is server-side: the route now accepts BOTH spellings. This
/// type is hoisted out of the view anyway, because a struct declared inside a
/// function body is not something a test can encode - which is exactly why
/// nobody ever looked at these bytes.
struct DisputeRequest: Encodable, Equatable {
    let gradeReportId: String
    let reason: String
    /// Base64 data-URI evidence photos. Omitted entirely when empty rather than
    /// sent as `[]` — the route treats a missing key and an empty array the
    /// same, and a text-only filing should not carry an empty field.
    let images: [String]?

    // NO CodingKeys, deliberately. They would read as protection and provide
    // none - see the note above. What the phone actually sends is
    // `grade_report_id`, and the route accepts it.

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
