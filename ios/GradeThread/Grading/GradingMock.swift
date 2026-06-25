import Foundation

/// Canned, offline responses for the FlipDesk → GradeThread grading bridge,
/// used ONLY when the UI-test runner passes `-uitest-mock-grading` (US-1153).
///
/// Decoding canned snake_case JSON through the SAME `.convertFromSnakeCase`
/// strategy the live ``GradingService`` uses keeps the wire-shape exactly in
/// sync — there are no hand-built `init`s to drift from the real decode path,
/// and the response types stay `Decodable`-only as on the wire. The grade is a
/// deterministic "Excellent" 8.5 so the capture → grade → draft journey asserts
/// a stable result without an Anthropic round-trip or any credits spent.
enum GradingMock {

    /// Submission id minted by ``submit`` and echoed by ``status`` so the
    /// poll-by-ref correlates within a single hermetic run.
    static let submissionRef = "uitest-grading-submission"

    static func validate(
        inventoryItemId: String, tier: GradeTierOption
    ) throws -> GradingValidateResponse {
        try decode("""
        {
          "user": {
            "plan": "pro",
            "grades_used_this_month": 0,
            "plan_limit": 30,
            "grades_remaining": 30,
            "included_remaining": 30,
            "credit_balance": 99
          },
          "items": [{
            "inventory_item_id": "\(inventoryItemId)",
            "tier": "\(tier.rawValue)",
            "cost": 0,
            "ready": true,
            "blockers": [],
            "title": "UI Test Garment",
            "garment_type": "shirt",
            "garment_category": "tops",
            "required_photo_types_missing": []
          }],
          "total_cost": 0,
          "credits_required": 0,
          "can_submit": true,
          "limit_exceeded": false
        }
        """)
    }

    static func submit(
        inventoryItemId: String, tier: GradeTierOption
    ) throws -> GradingSubmitResponse {
        try decode("""
        {
          "submitted": 1,
          "failed": 0,
          "results": [{
            "ok": true,
            "inventory_item_id": "\(inventoryItemId)",
            "submission_id": "\(submissionRef)",
            "flipdesk_grading_submission_id": "\(submissionRef)",
            "tier": "\(tier.rawValue)",
            "cost": 0
          }]
        }
        """)
    }

    static func status(submissionRef ref: String) throws -> GradingStatusResponse {
        try decode("""
        {
          "id": "\(ref)",
          "inventory_item_id": "uitest-item",
          "submission_id": "\(ref)",
          "tier": "standard",
          "status": "completed",
          "cost": 0,
          "submitted_at": null,
          "graded_at": null,
          "error": null,
          "item": {
            "title": "UI Test Garment",
            "grade_value": 8.5,
            "grade_label": "Excellent",
            "certificate_url": null
          },
          "grade_report": {
            "id": "uitest-report",
            "overall_score": 8.5,
            "grade_tier": "Excellent",
            "fabric_condition_score": 8.5,
            "structural_integrity_score": 8.5,
            "cosmetic_appearance_score": 8.0,
            "functional_elements_score": 9.0,
            "odor_cleanliness_score": 8.0,
            "ai_summary": "Hermetic UI-test grade report.",
            "confidence_score": 0.95,
            "certificate_id": null,
            "created_at": null
          }
        }
        """)
    }

    private static func decode<T: Decodable>(_ json: String) throws -> T {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(T.self, from: Data(json.utf8))
    }
}
