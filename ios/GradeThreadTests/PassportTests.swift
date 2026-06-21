import XCTest
@testable import GradeThread

/// Coverage for the Garment Passport viewer (US-1115): the pure confidence
/// taxonomy + chain-strength math (mirroring the web source of truth), the
/// PII-free timeline decoding from the exact edge JSON shape, and the small
/// display formatters.
final class PassportTests: XCTestCase {

    /// Mirrors the decoder ``EdgeAPI`` uses for the public passport read
    /// (snake_case → camelCase).
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder.iso8601.decode(T.self, from: Data(json.utf8))
    }

    // MARK: - Confidence taxonomy

    func test_confidenceLevel_coercion() {
        XCTAssertEqual(PassportConfidence.level(of: "deterministic"), .deterministic)
        XCTAssertEqual(PassportConfidence.level(of: "probable"), .probable)
        XCTAssertEqual(PassportConfidence.level(of: "unknown"), .unknown)
        XCTAssertEqual(PassportConfidence.level(of: "garbage"), .unknown)
        XCTAssertEqual(PassportConfidence.level(of: nil), .unknown)
    }

    func test_confidenceLabels_matchWebTaxonomy() {
        XCTAssertEqual(PassportConfidence.deterministic.label, "Verified")
        XCTAssertEqual(PassportConfidence.probable.label, "Probable")
        XCTAssertEqual(PassportConfidence.unknown.label, "Unverified")
    }

    // MARK: - Chain strength

    func test_chainStrength_empty_isNone() {
        let s = PassportChainStrength(confidences: [])
        XCTAssertEqual(s.label, .none)
        XCTAssertEqual(s.score, 0)
        XCTAssertEqual(s.summary, "No history recorded yet.")
    }

    func test_chainStrength_allDeterministic_isStrong() {
        let s = PassportChainStrength(confidences: ["deterministic", "deterministic"])
        XCTAssertEqual(s.deterministic, 2)
        XCTAssertEqual(s.score, 1.0, accuracy: 0.0001)
        XCTAssertEqual(s.label, .strong)
        XCTAssertEqual(s.summary, "2 of 2 links are independently verified.")
    }

    func test_chainStrength_mixed_classifies() {
        // 2 of 4 deterministic → 0.5 → Moderate.
        let moderate = PassportChainStrength(
            confidences: ["deterministic", "deterministic", "probable", "unknown"]
        )
        XCTAssertEqual(moderate.label, .moderate)
        XCTAssertEqual(moderate.probable, 1)
        XCTAssertEqual(moderate.unknown, 1)

        // 1 of 4 deterministic → 0.25 → Emerging.
        let emerging = PassportChainStrength(
            confidences: ["deterministic", "probable", "probable", "unknown"]
        )
        XCTAssertEqual(emerging.label, .emerging)
    }

    func test_chainStrength_singular_summaryGrammar() {
        let s = PassportChainStrength(confidences: ["deterministic"])
        XCTAssertEqual(s.summary, "1 of 1 link is independently verified.")
    }

    // MARK: - Timeline decoding (exact edge JSON)

    func test_timeline_decodesPiiFreeShape() throws {
        let json = """
        {
          "slug": "abc123def456",
          "sku_class": { "brand": "Patagonia", "garment_type": "fleece_jacket" },
          "status": "active",
          "created_at": "2026-06-20T12:00:00.000Z",
          "origin_verified_seller": {
            "handle": "thrifty",
            "display_name": "Thrifty Threads",
            "since": "2026-01-01T00:00:00.000Z"
          },
          "events": [
            {
              "event_type": "graded",
              "confidence": "deterministic",
              "actor": "Seller A",
              "actor_revealed": null,
              "source": "grading-pipeline",
              "payload": {
                "overall_score": 8.5,
                "grade_tier": "Excellent",
                "confidence_label": "high",
                "certificate": "CERT123"
              },
              "created_at": "2026-06-20T12:00:00.000Z"
            },
            {
              "event_type": "ownership_transfer",
              "confidence": "probable",
              "actor": "Buyer B",
              "actor_revealed": { "handle": "buyer", "display_name": null },
              "source": "claim",
              "payload": {},
              "created_at": "2026-06-21T12:00:00.000Z"
            }
          ]
        }
        """
        let timeline = try decode(PassportTimeline.self, json)

        XCTAssertEqual(timeline.slug, "abc123def456")
        XCTAssertEqual(timeline.status, "active")
        XCTAssertEqual(timeline.originVerifiedSeller?.handle, "thrifty")
        XCTAssertEqual(timeline.originVerifiedSeller?.displayName, "Thrifty Threads")
        XCTAssertEqual(timeline.events.count, 2)

        let graded = timeline.events[0]
        XCTAssertEqual(graded.eventType, "graded")
        XCTAssertEqual(graded.confidence, "deterministic")
        XCTAssertEqual(graded.actor, "Seller A")
        XCTAssertNil(graded.actorRevealed)
        XCTAssertEqual(graded.payload.overallScore, 8.5)
        XCTAssertEqual(graded.payload.gradeTier, "Excellent")
        XCTAssertEqual(graded.payload.certificate, "CERT123")
        XCTAssertEqual(graded.presentation.label, "Condition graded")

        let transfer = timeline.events[1]
        XCTAssertEqual(transfer.eventType, "ownership_transfer")
        XCTAssertEqual(transfer.actorRevealed?.handle, "buyer")
        XCTAssertNil(transfer.actorRevealed?.displayName)
        XCTAssertNil(transfer.payload.overallScore)
        XCTAssertEqual(transfer.presentation.label, "Ownership transferred")

        // The decoder camelCases nested keys; garmentName stays robust to it.
        XCTAssertEqual(PassportFormat.garmentName(from: timeline.skuClass), "Patagonia Fleece Jacket")
    }

    func test_timeline_decodesMinimalAndEmptyEvents() throws {
        let json = """
        { "slug": "s", "sku_class": {}, "status": "active",
          "created_at": "2026-06-20T12:00:00.000Z", "events": [] }
        """
        let timeline = try decode(PassportTimeline.self, json)
        XCTAssertNil(timeline.originVerifiedSeller)
        XCTAssertTrue(timeline.events.isEmpty)
        XCTAssertEqual(PassportFormat.garmentName(from: timeline.skuClass), "Graded garment")
    }

    // MARK: - Formatters

    func test_titleCase() {
        XCTAssertEqual(PassportFormat.titleCase("ownership_transfer"), "Ownership Transfer")
        XCTAssertEqual(PassportFormat.titleCase("very-good"), "Very Good")
        XCTAssertEqual(PassportFormat.titleCase("graded"), "Graded")
    }

    func test_longDate_parsesFractionalAndPlainISO() {
        XCTAssertEqual(PassportFormat.longDate("2026-06-20T12:00:00.000Z"), "June 20, 2026")
        XCTAssertEqual(PassportFormat.longDate("2026-06-20T12:00:00Z"), "June 20, 2026")
        // Unparseable input falls back to the raw string (never crashes).
        XCTAssertEqual(PassportFormat.longDate("not-a-date"), "not-a-date")
        XCTAssertEqual(PassportFormat.longDate(""), "")
    }
}
