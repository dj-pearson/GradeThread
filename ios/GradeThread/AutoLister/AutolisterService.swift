import Foundation

// AutoLister edge client. Thin wrapper over `EdgeAPI.shared` (auto-attaches the
// Supabase token, snake_case ⇄ camelCase, ISO-8601). Endpoints already exist on
// the Hono service (`services/edge-functions/src/routes/flipdesk-autolister.ts`)
// and are mounted at `/api/flipdesk/autolister/*`.
//
// The protocol seam mirrors `ScoutScanning`/`ScoutService` so the store is
// unit-testable with an in-memory mock (no network).

protocol AutolisterBatching {
    func startBatch(itemIds: [String], useComps: Bool, templateId: String?) async throws -> StartBatchResponse
    func batchStatus(batchId: String) async throws -> BatchStatusResponse
    func retryFailed(batchId: String) async throws -> RetryFailedResponse
    func classifyPhotos(_ photos: [ClassifyPhotoInput]) async throws -> ClassifyPhotosResponse
    func photoQa(itemIds: [String]) async throws -> PhotoQaResponse
}

struct AutolisterService: AutolisterBatching {
    private let api: EdgeAPI

    init(api: EdgeAPI = .shared) {
        self.api = api
    }

    private enum Path {
        static let batch = "/api/flipdesk/autolister/batch"
        static func status(_ id: String) -> String { "\(batch)/\(id)" }
        static func retry(_ id: String) -> String { "\(batch)/\(id)/retry-failed" }
        static let classify = "/api/flipdesk/autolister/classify-photos"
        static let photoQa = "/api/flipdesk/autolister/photo-qa"
    }

    // Request bodies. CodingKeys are derived by the shared encoder's
    // convertToSnakeCase strategy (itemIds → item_ids, useComps → use_comps,
    // storagePath → storage_path).
    private struct StartBatchBody: Encodable {
        let itemIds: [String]
        let useComps: Bool
        /// US-674: optional listing template applied to every generated draft.
        /// Omitted from the JSON when nil so existing batches are byte-identical.
        let templateId: String?
    }
    private struct PhotoQaBody: Encodable { let itemIds: [String] }
    private struct ClassifyBody: Encodable { let photos: [ClassifyPhotoInput] }
    /// `retry-failed` takes no body; the server resolves the batch from the path.
    /// `{}` is harmless.
    private struct EmptyBody: Encodable {}

    func startBatch(itemIds: [String], useComps: Bool, templateId: String?) async throws -> StartBatchResponse {
        try await api.postJSON(
            Path.batch,
            body: StartBatchBody(itemIds: itemIds, useComps: useComps, templateId: templateId)
        )
    }

    func batchStatus(batchId: String) async throws -> BatchStatusResponse {
        try await api.getJSON(Path.status(batchId))
    }

    func retryFailed(batchId: String) async throws -> RetryFailedResponse {
        try await api.postJSON(Path.retry(batchId), body: EmptyBody())
    }

    func classifyPhotos(_ photos: [ClassifyPhotoInput]) async throws -> ClassifyPhotosResponse {
        try await api.postJSON(Path.classify, body: ClassifyBody(photos: photos))
    }

    func photoQa(itemIds: [String]) async throws -> PhotoQaResponse {
        try await api.postJSON(Path.photoQa, body: PhotoQaBody(itemIds: itemIds))
    }
}
