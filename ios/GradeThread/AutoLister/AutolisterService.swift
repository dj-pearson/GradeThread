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
    // US-1548: group-boundary verification. Photos must live under the
    // caller's `_staging/` prefix, so the review uploads its boundary samples
    // first (stageVerificationPhoto) and then asks for merge/split/move
    // suggestions. Both have default no-op-ish implementations below so test
    // mocks that predate US-1548 keep compiling.
    func stageVerificationPhoto(sessionId: String, jpegData: Data) async throws -> String
    func verifyGroups(_ groups: [VerifyGroupPayload]) async throws -> VerifyGroupsResponse
}

extension AutolisterBatching {
    func stageVerificationPhoto(sessionId _: String, jpegData _: Data) async throws -> String {
        throw URLError(.unsupportedURL)
    }

    func verifyGroups(_: [VerifyGroupPayload]) async throws -> VerifyGroupsResponse {
        VerifyGroupsResponse(suggestions: [])
    }
}

// US-1548: verify-groups wire types (snake_case handled by EdgeAPI's coders).
struct VerifyGroupPhotoPayload: Encodable, Equatable {
    let id: String
    let storagePath: String
}

struct VerifyGroupPayload: Encodable, Equatable {
    let id: String
    let photos: [VerifyGroupPhotoPayload]
}

/// One AI suggestion about the grouping. `groupIds`/`photoIds` are the ids the
/// CALLER sent (the review model's own UUID strings) — the server maps its
/// G/P labels back before responding.
struct GroupVerifySuggestion: Decodable, Equatable, Identifiable {
    let type: String // "merge" | "split" | "move"
    let groupIds: [String]
    let photoIds: [String]
    let confidence: Double
    let reason: String

    var id: String {
        "\(type)|\(groupIds.joined(separator: ","))|\(photoIds.joined(separator: ","))"
    }
}

struct VerifyGroupsResponse: Decodable {
    let suggestions: [GroupVerifySuggestion]
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

    // MARK: - US-1548: verify-groups

    private struct VerifyGroupsBody: Encodable { let groups: [VerifyGroupPayload] }
    private struct StagingUploadResponse: Decodable {
        let storagePath: String
        private enum CodingKeys: String, CodingKey {
            case storagePath = "storage_path"
        }
    }

    func verifyGroups(_ groups: [VerifyGroupPayload]) async throws -> VerifyGroupsResponse {
        try await api.postJSON(
            "/api/flipdesk/autolister/verify-groups",
            body: VerifyGroupsBody(groups: groups)
        )
    }

    /// Upload one boundary-sample JPEG into the caller's `_staging/` folder so
    /// the verify endpoint may read it. Multipart (the one AutoLister call
    /// EdgeAPI's JSON transport can't carry), so it builds its own request; a
    /// dedicated ephemeral session keeps the Authorization header away from
    /// the Sentry-swizzled shared session. Returns the storage path.
    func stageVerificationPhoto(sessionId: String, jpegData: Data) async throws -> String {
        guard let token = await SupabaseShared.currentAccessToken() else {
            throw URLError(.userAuthenticationRequired)
        }
        var request = URLRequest(
            url: AppConfig.edgeAPIURL
                .appendingPathComponent("api/flipdesk/autolister/staging/upload")
        )
        request.httpMethod = "POST"
        let boundary = "gt-\(UUID().uuidString)"
        request.setValue(
            "multipart/form-data; boundary=\(boundary)",
            forHTTPHeaderField: "Content-Type"
        )
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        var body = Data()
        func appendField(_ text: String) { body.append(Data(text.utf8)) }
        appendField("--\(boundary)\r\n")
        appendField("Content-Disposition: form-data; name=\"session_id\"\r\n\r\n")
        appendField("\(sessionId)\r\n")
        appendField("--\(boundary)\r\n")
        appendField(
            "Content-Disposition: form-data; name=\"full\"; filename=\"photo.jpg\"\r\n"
        )
        appendField("Content-Type: image/jpeg\r\n\r\n")
        body.append(jpegData)
        appendField("\r\n--\(boundary)--\r\n")
        request.httpBody = body

        let (data, response) = try await Self.stagingSession.data(for: request)
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(StagingUploadResponse.self, from: data).storagePath
    }

    private static let stagingSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 60
        return URLSession(configuration: config)
    }()
}
