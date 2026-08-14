import Foundation

/// Wire types for the FlipDesk → GradeThread grading bridge
/// (`/api/flipdesk/grading/*`). The reseller path: an inventory item that
/// already has photos is submitted for a certified grade; the AI grade +
/// certificate are written back onto the item.
///
/// All of these decode with `.convertFromSnakeCase`, so the snake_case wire
/// keys (`inventory_item_id`, `overall_score`, …) map to camelCase here.

// MARK: - /validate

/// Per-item readiness + cost + the owner's plan/credit posture. Returned by
/// `POST /api/flipdesk/grading/validate` without creating any records.
struct GradingValidateResponse: Decodable {
    let user: GradingUserInfo
    let items: [GradingValidatedItem]
    let totalCost: Double
    let creditsRequired: Int
    let canSubmit: Bool
    let limitExceeded: Bool

    /// The single item this request was about (the reseller grades one item
    /// at a time from its canvas).
    var item: GradingValidatedItem? { items.first }
}

struct GradingUserInfo: Decodable {
    let plan: String
    let gradesUsedThisMonth: Int
    let planLimit: Int
    let gradesRemaining: Int
    let includedRemaining: Int
    let creditBalance: Int
}

struct GradingValidatedItem: Decodable {
    let inventoryItemId: String
    let tier: String
    let cost: Double
    let ready: Bool
    let blockers: [String]
    let title: String?
    let garmentType: String?
    let garmentCategory: String?
    let requiredPhotoTypesMissing: [String]
}

// MARK: - /submit

/// Result of `POST /api/flipdesk/grading/submit`. Partial success is normal
/// for a batch; the single-item reseller flow reads `results.first`.
struct GradingSubmitResponse: Decodable {
    let submitted: Int
    let failed: Int
    let results: [GradingSubmitResult]
}

/// Heterogeneous result row — success carries the submission ids, failure
/// carries an `error`. Discriminated by `ok`; every other field is optional.
struct GradingSubmitResult: Decodable {
    let ok: Bool
    let inventoryItemId: String
    let submissionId: String?
    let flipdeskGradingSubmissionId: String?
    let tier: String?
    let cost: Double?
    let error: String?
}

// MARK: - /submissions/:id (status + report)

/// Status poll for a single grading submission. `gradeReport` is populated
/// once `status == "completed"`.
struct GradingStatusResponse: Decodable {
    let id: String
    let inventoryItemId: String
    let submissionId: String?
    let tier: String
    let status: String
    let cost: Double
    let submittedAt: String?
    let gradedAt: String?
    let error: String?
    let item: GradingStatusItem
    let gradeReport: GradeReportDTO?

    /// Terminal-completed when the pipeline has written the report back.
    var isCompleted: Bool { status == "completed" }
    /// Mandatory review: the AI grade is produced but withheld until a human
    /// finalizes it. Not completed, not failed — a distinct terminal-ish poll
    /// state surfaced as "submitted for human review". `gradeReport` carries the
    /// provisional score (the edge resolves the preliminary report by submission).
    var isPendingReview: Bool { status == "pending_review" }
    /// Quality abstention: the AI withheld a grade because a core photo is
    /// unusable (blurry / dark / cut off / illegible label). Terminal for this
    /// poll — the seller needs to retake photos; no grade or charge resulted.
    /// `error` carries the human-readable reason. Distinct from `isFailed` so
    /// the UI can show actionable "needs clearer photos" guidance instead of a
    /// hard error.
    var isNeedsPhotos: Bool { status == "needs_photos" }
    /// Terminal-failed when the bridge recorded an error. (Checked AFTER
    /// `isNeedsPhotos` in the poller, since the abstention path also sets
    /// `error` but is not a hard failure — see GradeRequestStore.)
    var isFailed: Bool { (error?.isEmpty == false) || status == "failed" }
}

struct GradingStatusItem: Decodable {
    let title: String?
    let gradeValue: Double?
    let gradeLabel: String?
    let certificateUrl: String?
}

/// The grade report subset the bridge returns. (The full `grade_reports`
/// row has more fields — defects, per-image analysis — but the bridge
/// status endpoint returns exactly these.) `defectsFound` is only populated
/// by the on-demand full-report fetch (``ItemGradeReportService``); the
/// bridge omits it, so it decodes to nil there.
struct GradeReportDTO: Decodable, Equatable {
    let id: String
    let overallScore: Double
    let gradeTier: String
    let fabricConditionScore: Double
    let structuralIntegrityScore: Double
    let cosmeticAppearanceScore: Double
    let functionalElementsScore: Double
    let odorCleanlinessScore: Double
    let aiSummary: String
    let confidenceScore: Double
    let certificateId: String?
    let createdAt: String?
    var defectsFound: [GradeDefect]?
}

/// A genuine wear/damage finding (not intentional design). Mirrors
/// `DefectFound` on the web. Drives the "Detected issues" section.
struct GradeDefect: Decodable, Equatable, Identifiable {
    let defect: String
    let severity: String        // "minor" | "moderate" | "major"
    let location: String?
    let impactOnGrade: String?

    var id: String { "\(defect)|\(location ?? "")" }
}

// MARK: - Request bodies

/// Body for both `/validate` and `/submit`: `{ items: [{ inventory_item_id, tier }] }`.
/// Encoded with `.convertToSnakeCase`.
struct GradingRequestBody: Encodable {
    struct Item: Encodable {
        let inventoryItemId: String
        let tier: String
    }
    let items: [Item]

    /// US-2564: the charge token for THIS bulk submit.
    ///
    /// Grading is billed per garment and the edge keys its credit debit on
    /// `batch_key` + item id, so a retried batch charges once per garment rather
    /// than once per attempt. Nil for the single-item paths, which the edge
    /// treats exactly as it did before this field existed. `JSONEncoder` omits a
    /// nil Optional, so nothing is sent — and that matters: an empty string
    /// would be a REAL key shared by every keyless caller, so the first such
    /// charge would suppress every later one.
    let batchKey: String?

    init(inventoryItemId: String, tier: GradeTierOption) {
        self.items = [Item(inventoryItemId: inventoryItemId, tier: tier.rawValue)]
        self.batchKey = nil
    }

    /// Batch variant for bulk grading from inventory multi-select.
    init(itemIds: [String], tier: GradeTierOption) {
        self.items = itemIds.map { Item(inventoryItemId: $0, tier: tier.rawValue) }
        self.batchKey = GradingRequestBody.bulkBatchKey(itemIds, tier: tier.rawValue)
    }

    /// A stable, bounded charge token for (selection, tier).
    ///
    /// Mirrors `src/lib/bulk-batch-key.ts` on web and `GradingRequestBody
    /// .bulkBatchKey` on Android, deliberately down to the constants. The three
    /// clients do not need to agree on the VALUE — each only dedupes against its
    /// own retries — but they do need to agree on the BEHAVIOUR, or the same
    /// user action means different things depending on which app they used.
    ///
    /// Deterministic rather than a fresh UUID, because a UUID per attempt is the
    /// defect: a failed submit is the thing a seller retries hardest, and a new
    /// token on each press makes every retry a fresh set of charges.
    /// Order-insensitive, since the same garments picked in a different order are
    /// the same batch.
    ///
    /// The ids are DIGESTED, not carried: joining 200 UUIDs is ~7.4 KB and the
    /// edge's `.strict()` schema caps `batch_key` at 255 characters. FNV-1a is
    /// not cryptographic and does not need to be. Two independently-seeded
    /// passes plus the item count give enough discrimination that two different
    /// selections never share a token, which matters because a collision would
    /// silently drop a garment from a batch.
    ///
    /// Hashes over UTF-16 code units to match JS `charCodeAt`; `UInt32` with
    /// `&*` wraps, matching `Math.imul`.
    static func bulkBatchKey(_ inventoryItemIds: [String], tier: String) -> String? {
        guard !inventoryItemIds.isEmpty else { return nil }
        let canonical = "\(tier)|" + inventoryItemIds.sorted().joined(separator: ",")
        let a = fnv1a(canonical, seed: 0x811C_9DC5)
        let b = fnv1a(canonical, seed: 0x9E37_79B9)
        return "fdbulk-\(inventoryItemIds.count)-\(hex32(a))-\(hex32(b))"
    }

    private static func fnv1a(_ input: String, seed: UInt32) -> UInt32 {
        var hash = seed
        for unit in input.utf16 {
            hash ^= UInt32(unit)
            hash = hash &* 0x0100_0193
        }
        return hash
    }

    private static func hex32(_ value: UInt32) -> String {
        String(format: "%08x", value)
    }
}
