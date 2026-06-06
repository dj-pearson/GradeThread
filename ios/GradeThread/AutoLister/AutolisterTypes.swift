import Foundation

// AutoLister wire models. Mirror the web contract in `src/hooks/use-autolister.ts`
// and the edge service in `services/edge-functions/src/routes/flipdesk-autolister.ts`.
//
// Decoding goes through `EdgeAPI`'s shared decoder (`JSONDecoder.iso8601`,
// `convertFromSnakeCase`), so server `snake_case` columns map to the camelCase
// properties below automatically. Timestamps are kept as `String` (not `Date`)
// to match the web shape and to sidestep ISO-8601 fractional-second parsing — the
// queue UI only displays progress, never does date math on these.

/// Terminal + in-flight states of a generation batch (web `ListingGenerationStatus`).
enum AutolisterBatchStatus: String, Codable, Equatable {
    case pending, running, completed, failed, partial

    /// A batch in one of these states has no more open jobs; polling can stop.
    var isTerminal: Bool {
        switch self {
        case .completed, .failed, .partial: return true
        case .pending, .running: return false
        }
    }
}

/// Per-item job state (web `ListingGenerationJobStatus`).
enum AutolisterJobStatus: String, Codable, Equatable {
    case pending, running, success, failed
}

struct AutolisterBatch: Codable, Equatable {
    let id: String
    let status: AutolisterBatchStatus
    let source: String?
    let itemCount: Int
    let succeededCount: Int
    let failedCount: Int
    let error: String?
    let createdAt: String?
    let updatedAt: String?
}

struct AutolisterJob: Codable, Equatable, Identifiable {
    let id: String
    let inventoryItemId: String
    let status: AutolisterJobStatus
    let error: String?
    let attempts: Int
    let listingId: String?
    let updatedAt: String?
}

/// `GET /api/flipdesk/autolister/batch/:id`
struct BatchStatusResponse: Codable, Equatable {
    let batch: AutolisterBatch
    let jobs: [AutolisterJob]
}

/// `POST /api/flipdesk/autolister/batch`
struct StartBatchResponse: Codable, Equatable {
    let batchId: String
    let itemCount: Int
}

/// `POST /api/flipdesk/autolister/batch/:id/retry-failed`
struct RetryFailedResponse: Codable, Equatable {
    let batchId: String
    let retried: Int
}

// MARK: - Classify photos (US-533)

/// One staged photo handed to the cover/role vision pass. `storagePath` is the
/// `item-photos` object path the upload created (`{userId}/{itemId}/...`).
struct ClassifyPhotoInput: Codable, Equatable {
    let id: String
    let storagePath: String
}

/// `POST /api/flipdesk/autolister/classify-photos` →
/// `{ cover_id, roles: { photoId: role } }`.
///
/// `roles` keys are our own photo ids (UUIDs — no underscores), so the shared
/// `convertFromSnakeCase` key strategy leaves them untouched.
struct ClassifyPhotosResponse: Codable, Equatable {
    let coverId: String?
    let roles: [String: String]
}

// MARK: - Photo QA (US-537)

struct PhotoQaIssue: Codable, Equatable {
    let type: String
    let severity: String
    let message: String
    let photoIndex: Int?
}

/// One item's photo-readiness result. `score` is 0–100, or -1 when the QA pass
/// errored for that item.
struct PhotoQaResult: Codable, Equatable, Identifiable {
    var id: String { itemId }
    let itemId: String
    let score: Int
    let issues: [PhotoQaIssue]
    let error: String?
}

/// `POST /api/flipdesk/autolister/photo-qa`
struct PhotoQaResponse: Codable, Equatable {
    let results: [PhotoQaResult]
}
