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

/// US-2688, the half of this bug that is about the customer rather than the wire.
///
/// The sheet shows the server's own `error` string, and that is deliberate: the
/// two rejections a seller can actually hit - the 7-day window has closed, a
/// dispute already exists - are worded by the side that owns the rule, and
/// US-2153 exists so the window length is never hardcoded here.
///
/// The failure mode is what happens when the server's string is NOT customer
/// copy. "gradeReportId is required" went straight to the screen of someone who
/// had just paid for a grade, was inside a window they could not reopen, and had
/// no way to act on it. The edge no longer sends that, but the sheet should not
/// depend on every future validation message being written with a customer in
/// mind. A developer string reaching a customer is a defect wherever it starts.
///
/// Pure and free of any view, so it is tested directly rather than through UI.
enum DisputeErrorCopy {
    /// Shown instead of a message a person cannot act on.
    static let fallback =
        "We couldn't file your dispute. Please try again, and contact support if it keeps happening."

    /// True when `message` reads like an identifier out of the source rather
    /// than a sentence: a snake_case or camelCase token with no spaces in it.
    /// Prose never contains one; a validation message written against a field
    /// name always does.
    ///
    /// The camelCase head must be at least three letters, and that is not a
    /// tuning knob - it is what keeps `eBay`, `iPhone` and `iOS` out. All three
    /// are camelCase by shape and all three are ordinary words in seller copy,
    /// so a rule without it would replace a perfectly good sentence about eBay
    /// with a generic apology. A real field name starts with a whole word:
    /// grade, item, listing, payout.
    static func namesAProperty(_ message: String) -> Bool {
        let snake = "^[a-z][a-z0-9]*(_[a-z0-9]+)+$"
        let camel = "^[a-z]{3}[a-z0-9]*([A-Z][a-zA-Z0-9]*)+$"
        for token in message.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" }) {
            let word = token.trimmingCharacters(in: CharacterSet(charactersIn: "\"'`.,:;()[]"))
            if word.isEmpty { continue }
            if word.range(of: snake, options: .regularExpression) != nil { return true }
            if word.range(of: camel, options: .regularExpression) != nil { return true }
        }
        return false
    }

    /// The line to put on screen for a server message.
    static func customerFacing(_ message: String) -> String {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return fallback }
        return namesAProperty(trimmed) ? fallback : trimmed
    }
}
