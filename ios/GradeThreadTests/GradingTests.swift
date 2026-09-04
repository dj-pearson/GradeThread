import SwiftData
import SwiftUI
import XCTest
@testable import GradeThread

/// Coverage for the certified-grade (FlipDesk → GradeThread bridge) flow:
/// wire decoding (matching the edge JSON exactly), request encoding, and the
/// shared grading domain model (factors, scale, certificate links).
final class GradingTests: XCTestCase {

    /// Mirrors the decoder GradingService uses (snake_case → camelCase).
    private func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try decoder().decode(T.self, from: Data(json.utf8))
    }

    // MARK: - /validate decoding

    func test_validateResponse_decodes() throws {
        let json = """
        {
          "user": {
            "plan": "pro",
            "grades_used_this_month": 4,
            "plan_limit": 30,
            "grades_remaining": 28,
            "included_remaining": 26,
            "credit_balance": 2
          },
          "items": [{
            "inventory_item_id": "11111111-1111-1111-1111-111111111111",
            "tier": "standard",
            "cost": 2.99,
            "ready": true,
            "blockers": [],
            "title": "Patagonia Better Sweater",
            "garment_type": "outerwear",
            "garment_category": "jacket",
            "required_photo_types_missing": []
          }],
          "total_cost": 2.99,
          "credits_required": 0,
          "can_submit": true,
          "limit_exceeded": false
        }
        """
        let res = try decode(GradingValidateResponse.self, json)
        XCTAssertTrue(res.canSubmit)
        XCTAssertFalse(res.limitExceeded)
        XCTAssertEqual(res.user.includedRemaining, 26)
        XCTAssertEqual(res.user.creditBalance, 2)
        XCTAssertEqual(res.item?.inventoryItemId, "11111111-1111-1111-1111-111111111111")
        XCTAssertTrue(res.item?.ready ?? false)
        XCTAssertEqual(res.item?.requiredPhotoTypesMissing, [])
    }

    func test_validateResponse_notReady_surfacesBlockers() throws {
        let json = """
        {
          "user": {"plan":"free","grades_used_this_month":3,"plan_limit":3,
                   "grades_remaining":0,"included_remaining":0,"credit_balance":0},
          "items": [{
            "inventory_item_id":"abc","tier":"standard","cost":2.99,
            "ready":false,
            "blockers":["Missing required photos: tag","Missing garment_type"],
            "title":"Tee","garment_type":null,"garment_category":"t-shirt",
            "required_photo_types_missing":["tag"]
          }],
          "total_cost":2.99,"credits_required":1,"can_submit":false,"limit_exceeded":true
        }
        """
        let res = try decode(GradingValidateResponse.self, json)
        XCTAssertFalse(res.canSubmit)
        XCTAssertTrue(res.limitExceeded)
        XCTAssertEqual(res.item?.blockers.count, 2)
        XCTAssertEqual(res.item?.requiredPhotoTypesMissing, ["tag"])
        XCTAssertNil(res.item?.garmentType)
    }

    // MARK: - /submit decoding

    func test_submitResponse_success_carriesGradingSubmissionId() throws {
        let json = """
        {
          "submitted": 1, "failed": 0,
          "results": [{
            "ok": true,
            "inventory_item_id": "item-1",
            "submission_id": "sub-1",
            "flipdesk_grading_submission_id": "fd-1",
            "tier": "standard",
            "cost": 2.99
          }]
        }
        """
        let res = try decode(GradingSubmitResponse.self, json)
        XCTAssertEqual(res.submitted, 1)
        let first = try XCTUnwrap(res.results.first)
        XCTAssertTrue(first.ok)
        XCTAssertEqual(first.flipdeskGradingSubmissionId, "fd-1")
        XCTAssertNil(first.error)
    }

    func test_submitResponse_failure_carriesError() throws {
        let json = """
        {
          "submitted": 0, "failed": 1,
          "results": [{
            "ok": false,
            "inventory_item_id": "item-1",
            "error": "Payment required for premium grade — not enough grading credits."
          }]
        }
        """
        let res = try decode(GradingSubmitResponse.self, json)
        let first = try XCTUnwrap(res.results.first)
        XCTAssertFalse(first.ok)
        XCTAssertNil(first.flipdeskGradingSubmissionId)
        XCTAssertEqual(first.error?.isEmpty, false)
    }

    // MARK: - /submissions/:id decoding

    func test_statusResponse_completed_withReport() throws {
        let json = """
        {
          "id": "fd-1",
          "inventory_item_id": "item-1",
          "submission_id": "sub-1",
          "tier": "standard",
          "status": "completed",
          "cost": 2.99,
          "submitted_at": "2026-06-05T12:00:00.000Z",
          "graded_at": "2026-06-05T12:00:31.000Z",
          "error": null,
          "item": {
            "title": "Patagonia Better Sweater",
            "grade_value": 8.5,
            "grade_label": "Excellent",
            "certificate_url": "https://gradethread.com/cert/CERT123"
          },
          "grade_report": {
            "id": "report-1",
            "overall_score": 8.5,
            "grade_tier": "Excellent",
            "fabric_condition_score": 9.0,
            "structural_integrity_score": 8.5,
            "cosmetic_appearance_score": 8.0,
            "functional_elements_score": 8.0,
            "odor_cleanliness_score": 9.0,
            "ai_summary": "Light pilling on the cuffs; otherwise excellent.",
            "confidence_score": 0.91,
            "certificate_id": "CERT123",
            "created_at": "2026-06-05T12:00:31.000Z"
          }
        }
        """
        let res = try decode(GradingStatusResponse.self, json)
        XCTAssertTrue(res.isCompleted)
        XCTAssertFalse(res.isFailed)
        let report = try XCTUnwrap(res.gradeReport)
        XCTAssertEqual(report.overallScore, 8.5)
        XCTAssertEqual(report.fabricConditionScore, 9.0)
        XCTAssertEqual(report.certificateId, "CERT123")
        XCTAssertEqual(res.item.certificateUrl, "https://gradethread.com/cert/CERT123")
    }

    func test_gradeReport_decodesDefectsWhenPresent() throws {
        // Shape returned by the on-demand full-report fetch (edge decoder
        // path uses convertFromSnakeCase too in this test harness).
        let json = """
        {
          "id": "r", "overall_score": 6.5, "grade_tier": "Good",
          "fabric_condition_score": 6, "structural_integrity_score": 7,
          "cosmetic_appearance_score": 6, "functional_elements_score": 7,
          "odor_cleanliness_score": 7, "ai_summary": "Minor wear.",
          "confidence_score": 0.82, "certificate_id": "C1", "created_at": null,
          "defects_found": [
            {"defect": "pilling", "severity": "minor", "location": "cuffs", "impact_on_grade": "−0.5"},
            {"defect": "stain", "severity": "moderate", "location": "left hem"}
          ]
        }
        """
        let report = try decode(GradeReportDTO.self, json)
        let defects = try XCTUnwrap(report.defectsFound)
        XCTAssertEqual(defects.count, 2)
        XCTAssertEqual(defects[0].defect, "pilling")
        XCTAssertEqual(defects[0].severity, "minor")
        XCTAssertEqual(defects[0].location, "cuffs")
        XCTAssertEqual(defects[1].location, "left hem")
        XCTAssertNil(defects[1].impactOnGrade)
    }

    func test_gradeReport_absentDefectsIsNil() throws {
        let json = """
        {
          "id": "r", "overall_score": 8, "grade_tier": "Excellent",
          "fabric_condition_score": 8, "structural_integrity_score": 8,
          "cosmetic_appearance_score": 8, "functional_elements_score": 8,
          "odor_cleanliness_score": 8, "ai_summary": "Great.",
          "confidence_score": 0.9, "certificate_id": null, "created_at": null
        }
        """
        let report = try decode(GradeReportDTO.self, json)
        XCTAssertNil(report.defectsFound)
    }

    func test_statusResponse_pending_hasNoReport() throws {
        let json = """
        {
          "id":"fd-1","inventory_item_id":"item-1","submission_id":"sub-1",
          "tier":"standard","status":"pending","cost":2.99,
          "submitted_at":"2026-06-05T12:00:00.000Z","graded_at":null,"error":null,
          "item":{"title":"Tee","grade_value":null,"grade_label":null,"certificate_url":null},
          "grade_report": null
        }
        """
        let res = try decode(GradingStatusResponse.self, json)
        XCTAssertFalse(res.isCompleted)
        XCTAssertFalse(res.isFailed)
        XCTAssertNil(res.gradeReport)
    }

    // MARK: - Request encoding

    func test_requestBody_encodesSnakeCaseSingleItem() throws {
        let body = GradingRequestBody(inventoryItemId: "item-9", tier: .premium)
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        let data = try encoder.encode(body)
        let str = String(decoding: data, as: UTF8.self)
        XCTAssertTrue(str.contains("\"inventory_item_id\":\"item-9\""))
        XCTAssertTrue(str.contains("\"tier\":\"premium\""))
        // Round-trips back to a single-item batch.
        struct Echo: Decodable { struct I: Decodable { let inventory_item_id: String; let tier: String }; let items: [I] }
        let echo = try JSONDecoder().decode(Echo.self, from: data)
        XCTAssertEqual(echo.items.count, 1)
        XCTAssertEqual(echo.items.first?.tier, "premium")
    }

    func test_requestBody_batchEncodesAllItems() throws {
        let body = GradingRequestBody(itemIds: ["a", "b", "c"], tier: .standard)
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        let data = try encoder.encode(body)
        struct Echo: Decodable {
            struct I: Decodable { let inventory_item_id: String; let tier: String }
            let items: [I]
        }
        let echo = try JSONDecoder().decode(Echo.self, from: data)
        XCTAssertEqual(echo.items.map(\.inventory_item_id), ["a", "b", "c"])
        XCTAssertTrue(echo.items.allSatisfy { $0.tier == "standard" })
    }

    // MARK: - Domain model

    func test_gradeFactorWeightsSumToOne() {
        let total = GradeFactor.allCases.reduce(0) { $0 + $1.weight }
        XCTAssertEqual(total, 1.0, accuracy: 0.0001)
    }

    func test_gradeFactorScoreMapping() {
        let report = GradeReportDTO(
            id: "r", overallScore: 7, gradeTier: "Very Good",
            fabricConditionScore: 1, structuralIntegrityScore: 2,
            cosmeticAppearanceScore: 3, functionalElementsScore: 4,
            odorCleanlinessScore: 5, aiSummary: "", confidenceScore: 0.8,
            certificateId: nil, createdAt: nil, defectsFound: nil
        )
        XCTAssertEqual(GradeFactor.fabricCondition.score(in: report), 1)
        XCTAssertEqual(GradeFactor.structuralIntegrity.score(in: report), 2)
        XCTAssertEqual(GradeFactor.cosmeticAppearance.score(in: report), 3)
        XCTAssertEqual(GradeFactor.functionalElements.score(in: report), 4)
        XCTAssertEqual(GradeFactor.odorCleanliness.score(in: report), 5)
    }

    func test_tierCreditCosts() {
        XCTAssertEqual(GradeTierOption.standard.creditCost, 1)
        XCTAssertEqual(GradeTierOption.premium.creditCost, 3)
        XCTAssertEqual(GradeTierOption.express.creditCost, 5)
    }

    func test_certificateLink_buildsAndPrefersExplicit() {
        XCTAssertEqual(
            CertificateLink.url(certificateId: "ABC")?.absoluteString,
            "https://gradethread.com/cert/ABC"
        )
        // Explicit absolute URL wins.
        let explicit = CertificateLink.resolve(
            explicit: "https://example.com/cert/XYZ", certificateId: "ABC"
        )
        XCTAssertEqual(explicit?.absoluteString, "https://example.com/cert/XYZ")
        // Falls back to the id when explicit is missing.
        let fallback = CertificateLink.resolve(explicit: nil, certificateId: "ABC")
        XCTAssertEqual(fallback?.absoluteString, "https://gradethread.com/cert/ABC")
        // Nothing to build from.
        XCTAssertNil(CertificateLink.resolve(explicit: nil, certificateId: nil))
    }

    // MARK: - Low-confidence review gate (US-1209)

    func test_gradeReviewThreshold_isPointSevenFive() {
        XCTAssertEqual(GradeScale.gradeReviewConfidenceThreshold, 0.75, accuracy: 0.0001)
    }

    func test_requiresReview_belowThreshold_isProvisional() {
        XCTAssertTrue(GradeScale.requiresReview(confidence: 0.0))
        XCTAssertTrue(GradeScale.requiresReview(confidence: 0.5))
        XCTAssertTrue(GradeScale.requiresReview(confidence: 0.7499))
        // The floor is inclusive: exactly 0.75 certifies automatically.
        XCTAssertFalse(GradeScale.requiresReview(confidence: 0.75))
        XCTAssertFalse(GradeScale.requiresReview(confidence: 0.91))
    }

    /// AC #1: a sub-0.75 grade is treated as provisional — score/tier surface
    /// (so the report can show the "flagged for human review" copy) but the
    /// status is NOT stamped "graded" and the certificate URL is held back.
    @MainActor
    func test_applyGrade_lowConfidence_doesNotCertify() throws {
        let context = ModelContext(try makeGradeContainer())
        let item = makeGradeItem(id: "low", status: "photographed", context: context)
        let report = makeReport(overallScore: 6.5, gradeTier: "Good", confidence: 0.62)

        GradeApplication.stamp(
            report,
            certificateURL: URL(string: "https://gradethread.com/cert/C1"),
            onto: item
        )

        XCTAssertEqual(item.gradeValue, 6.5)
        XCTAssertEqual(item.gradeLabel, "Good")
        // Certificate withheld even though one was offered.
        XCTAssertNil(item.certificateURL)
        // Status stays at its pre-grade stage — not promoted to certified.
        XCTAssertEqual(item.status, "photographed")
        // Derived signal the list/canvas use to badge "Pending review".
        XCTAssertTrue(item.isGradePendingReview)
    }

    /// Contrast: a high-confidence grade certifies (status graded + certificate
    /// stored), so the gate is specific to the sub-threshold path.
    @MainActor
    func test_applyGrade_highConfidence_certifies() throws {
        let context = ModelContext(try makeGradeContainer())
        let item = makeGradeItem(id: "high", status: "photographed", context: context)
        let report = makeReport(overallScore: 8.5, gradeTier: "Excellent", confidence: 0.91)

        GradeApplication.stamp(
            report,
            certificateURL: URL(string: "https://gradethread.com/cert/C2"),
            onto: item
        )

        XCTAssertEqual(item.gradeValue, 8.5)
        XCTAssertEqual(item.certificateURL, "https://gradethread.com/cert/C2")
        XCTAssertEqual(item.status, "graded")
        XCTAssertFalse(item.isGradePendingReview)
    }

    /// US-1409: a FINALIZED grade whose certificate was withheld (moderation,
    /// US-484) or nulled on a re-grade supersede has a null `certificateURL` but
    /// a linked `gradeReportId`. It must NOT read as "Pending review" forever —
    /// the report id is the server's finalization signal.
    @MainActor
    func test_isGradePendingReview_false_whenFinalizedButCertificateWithheld() throws {
        let context = ModelContext(try makeGradeContainer())
        let item = makeGradeItem(id: "withheld", status: "graded", context: context)
        item.gradeValue = 8.6
        item.certificateURL = nil          // cert withheld / superseded
        item.gradeReportId = "report-123"  // but the grade IS finalized
        XCTAssertFalse(item.isGradePendingReview)
    }

    /// Contrast: graded, no certificate, and NO report id yet = genuinely awaiting
    /// review → still pending.
    @MainActor
    func test_isGradePendingReview_true_whenNoCertAndNoReportId() throws {
        let context = ModelContext(try makeGradeContainer())
        let item = makeGradeItem(id: "awaiting", status: "photographed", context: context)
        item.gradeValue = 5.5
        item.certificateURL = nil
        item.gradeReportId = nil
        XCTAssertTrue(item.isGradePendingReview)
    }

    func test_gradeScaleColorThresholds() {
        // THREE bands since 2026-09-04, matching the web and Android exactly
        // (US-3010 AC6, owner's decision; vault/20-domain/brand-design-system.md §3B
        // was amended in the same commit): >= 7.0 Emerald, 5.0 to 6.9 Amber,
        // < 5.0 Crimson. The Steel Navy band this used to assert is gone - it
        // made a 7.0-to-9.4 garment navy on a phone and green on a laptop.
        XCTAssertEqual(GradeScale.color(for: 9.5), .brandEmerald)
        XCTAssertEqual(GradeScale.color(for: 9.4), .brandEmerald) // was Steel Navy
        XCTAssertEqual(GradeScale.color(for: 7.0), .brandEmerald) // inclusive floor, was Steel Navy
        XCTAssertEqual(GradeScale.color(for: 6.9), .brandAmber)
        XCTAssertEqual(GradeScale.color(for: 5.0), .brandAmber)
        XCTAssertEqual(GradeScale.color(for: 4.9), .brandRed)

        // The tier SYMBOL still separates 9.5+ from 7.0+, which is the whole
        // point of US-1281 now that both are the same colour.
        XCTAssertNotEqual(GradeScale.tierSymbol(for: 9.5), GradeScale.tierSymbol(for: 7.0))
    }

    // MARK: - Helpers (US-1209)

    private func makeReport(
        overallScore: Double,
        gradeTier: String,
        confidence: Double
    ) -> GradeReportDTO {
        GradeReportDTO(
            id: "r", overallScore: overallScore, gradeTier: gradeTier,
            fabricConditionScore: overallScore, structuralIntegrityScore: overallScore,
            cosmeticAppearanceScore: overallScore, functionalElementsScore: overallScore,
            odorCleanlinessScore: overallScore, aiSummary: "", confidenceScore: confidence,
            certificateId: "C", createdAt: nil, defectsFound: nil
        )
    }

    @MainActor
    private func makeGradeContainer() throws -> ModelContainer {
        let schema = Schema([
            LocalInventoryItem.self,
            LocalItemPhoto.self,
            LocalListing.self,
            LocalSale.self,
            LocalSource.self,
            LocalSourcer.self,
            LocalPendingMutation.self,
        ])
        let config = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true, cloudKitDatabase: .none)
        return try ModelContainer(for: schema, configurations: config)
    }

    @MainActor
    private func makeGradeItem(
        id: String,
        status: String,
        context: ModelContext
    ) -> LocalInventoryItem {
        let item = LocalInventoryItem(id: id, userId: "u", title: "Item", status: status)
        context.insert(item)
        return item
    }
}
