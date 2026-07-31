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
    // US-1909: AI group-boundary proposal over ONE window of ordered ungrouped
    // photos (the web's US-1904 "AI group remaining"). Same `_staging/` tenant
    // rule as verify-groups.
    func proposeGroups(_ photos: [ProposePhotoPayload]) async throws -> ProposeGroupsResponse
    // US-2374: the phone → desktop handoff. `stagePhoto` is the general form of
    // `stageVerificationPhoto` (it keeps the whole upload result, not just the
    // path); `createHandoffSession` parks the staged photos + grouping for the
    // desktop AutoLister to pick up.
    func stagePhoto(
        sessionId: String,
        jpegData: Data,
        thumbnailData: Data?
    ) async throws -> StagedPhotoUpload
    func createHandoffSession(
        stagingSessionId: String,
        photos: [HandoffPhotoPayload],
        groups: [HandoffGroupPayload]
    ) async throws -> HandoffSessionResponse
}

extension AutolisterBatching {
    func stageVerificationPhoto(sessionId _: String, jpegData _: Data) async throws -> String {
        throw URLError(.unsupportedURL)
    }

    func verifyGroups(_: [VerifyGroupPayload]) async throws -> VerifyGroupsResponse {
        VerifyGroupsResponse(suggestions: [])
    }

    func proposeGroups(_: [ProposePhotoPayload]) async throws -> ProposeGroupsResponse {
        ProposeGroupsResponse(groups: [])
    }

    func stagePhoto(
        sessionId _: String,
        jpegData _: Data,
        thumbnailData _: Data?
    ) async throws -> StagedPhotoUpload {
        throw URLError(.unsupportedURL)
    }

    func createHandoffSession(
        stagingSessionId _: String,
        photos _: [HandoffPhotoPayload],
        groups _: [HandoffGroupPayload]
    ) async throws -> HandoffSessionResponse {
        throw URLError(.unsupportedURL)
    }
}

// MARK: - US-2374: phone → desktop handoff wire types

/// A non-2xx from the staging upload endpoint. Carries the status so the retry
/// can tell "slow down" (429) and "the server fell over" (5xx) apart from "this
/// image is not acceptable" (any other 4xx), which no amount of retrying fixes.
struct StagingUploadError: Error, Equatable {
    let status: Int
    let retryAfter: TimeInterval?

    var isRetryable: Bool {
        status == 429 || (500..<600).contains(status)
    }
}

/// One photo's staging upload result — everything the desktop needs to render
/// it without re-uploading a byte.
struct StagedPhotoUpload: Decodable, Equatable {
    let storagePath: String
    let url: String
    let thumbnailStoragePath: String?
    let thumbnailUrl: String?
    let width: Int?
    let height: Int?
    let bytes: Int?

    private enum CodingKeys: String, CodingKey {
        case storagePath = "storage_path"
        case url
        case thumbnailStoragePath = "thumbnail_storage_path"
        case thumbnailUrl = "thumbnail_url"
        case width
        case height
        case bytes
    }
}

/// A staged photo as the handoff session stores it. `capturedAtMs` is sent ONLY
/// for photos with a real EXIF time — a fabricated one would make the desktop's
/// auto-grouping see a burst that never happened (the same trap US-1909 fixed
/// on this side).
struct HandoffPhotoPayload: Encodable, Equatable {
    let id: String
    let storagePath: String
    let thumbnailStoragePath: String?
    let width: Int?
    let height: Int?
    let bytes: Int?
    let capturedAtMs: Int?
    let sourceName: String?
    /// 16-hex dHash, the shape the web's visual-merge pass expects.
    let phash: String
}

struct HandoffGroupPayload: Encodable, Equatable {
    let id: String
    let photoIds: [String]
    let coverId: String
}

/// Decoded through `EdgeAPI`, whose decoder is `.convertFromSnakeCase` — hence
/// camelCase properties and NO explicit CodingKeys (they'd be looked up after
/// the conversion has already renamed the keys, and miss).
struct HandoffSessionResponse: Decodable {
    let id: String
    let photoCount: Int
    let groupCount: Int
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

// US-1909: propose-groups wire types. The endpoint writes NOTHING — the client
// applies confident proposals and surfaces uncertain boundaries for review.
struct ProposePhotoPayload: Encodable, Equatable {
    let id: String
    let storagePath: String
}

/// One proposed item boundary. `confidence` is the model's 0…1 certainty; the
/// review model applies it outright above `proposeApplyFloor` and otherwise
/// surfaces it as a chip the seller confirms.
struct ClientProposedGroup: Decodable, Equatable, Identifiable {
    var photoIds: [String]
    var confidence: Double
    var reason: String

    var id: String { photoIds.joined(separator: ",") }
}

struct ProposeGroupsResponse: Decodable {
    let groups: [ClientProposedGroup]
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

    func verifyGroups(_ groups: [VerifyGroupPayload]) async throws -> VerifyGroupsResponse {
        try await api.postJSON(
            "/api/flipdesk/autolister/verify-groups",
            body: VerifyGroupsBody(groups: groups)
        )
    }

    // MARK: - US-1909: propose-groups

    private struct ProposeGroupsBody: Encodable { let photos: [ProposePhotoPayload] }

    func proposeGroups(_ photos: [ProposePhotoPayload]) async throws -> ProposeGroupsResponse {
        try await api.postJSON(
            "/api/flipdesk/autolister/propose-groups",
            body: ProposeGroupsBody(photos: photos)
        )
    }

    /// Upload one boundary-sample JPEG into the caller's `_staging/` folder so
    /// the verify endpoint may read it. Returns the storage path.
    func stageVerificationPhoto(sessionId: String, jpegData: Data) async throws -> String {
        try await stagePhoto(sessionId: sessionId, jpegData: jpegData, thumbnailData: nil)
            .storagePath
    }

    /// Upload one photo into the caller's `_staging/` folder, optionally with a
    /// thumbnail (US-2374 — the handoff needs one so the desktop grid renders
    /// without pulling 200 full-size images). Multipart (the one AutoLister call
    /// EdgeAPI's JSON transport can't carry), so it builds its own request; a
    /// dedicated ephemeral session keeps the Authorization header away from
    /// the Sentry-swizzled shared session.
    /// US-2374: the staging endpoint is rate-limited at 120 uploads/minute, and
    /// a handoff sends the WHOLE batch — 200 photos on a fast connection walks
    /// straight into a 429. Without this the caller would read that as "photo
    /// failed" and silently drop it from the batch, so the seller's desktop
    /// would be missing photos with nothing to explain it. Retry on 429 (the
    /// server's own Retry-After, when it sends one) and on 5xx; never on a 4xx
    /// that says the image itself is wrong. Mirrors the web uploader's
    /// `uploadStagingPhoto` retry loop.
    static let maxStagingUploadAttempts = 4

    func stagePhoto(
        sessionId: String,
        jpegData: Data,
        thumbnailData: Data?
    ) async throws -> StagedPhotoUpload {
        var attempt = 0
        while true {
            do {
                return try await performStagingUpload(
                    sessionId: sessionId,
                    jpegData: jpegData,
                    thumbnailData: thumbnailData
                )
            } catch let error as StagingUploadError {
                attempt += 1
                guard error.isRetryable, attempt < Self.maxStagingUploadAttempts else { throw error }
                let delay = Self.stagingRetryDelay(
                    attempt: attempt,
                    retryAfter: error.retryAfter
                )
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            }
        }
    }

    /// PURE: how long to wait before re-trying a staging upload. Honours the
    /// server's `Retry-After` when it sent one, otherwise backs off
    /// exponentially, and is capped so a stuck limiter can't park the whole
    /// handoff behind one photo.
    static func stagingRetryDelay(attempt: Int, retryAfter: TimeInterval?) -> TimeInterval {
        let backoff = min(pow(2.0, Double(max(attempt, 1) - 1)), 8)
        return min(max(retryAfter ?? backoff, 0.5), 10)
    }

    private func performStagingUpload(
        sessionId: String,
        jpegData: Data,
        thumbnailData: Data?
    ) async throws -> StagedPhotoUpload {
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
        // US-670: scope the staged sample to the active workspace, mirroring
        // EdgeAPI.buildRequest. Without it, a user working inside a shared
        // workspace stages the verification photo under their personal tenant.
        if let workspaceOwner = WorkspaceScope.activeOwnerId {
            request.setValue(workspaceOwner, forHTTPHeaderField: "X-Workspace-Owner")
        }

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
        appendField("\r\n")
        if let thumbnailData {
            appendField("--\(boundary)\r\n")
            appendField(
                "Content-Disposition: form-data; name=\"thumb\"; filename=\"thumb.jpg\"\r\n"
            )
            appendField("Content-Type: image/jpeg\r\n\r\n")
            body.append(thumbnailData)
            appendField("\r\n")
        }
        appendField("--\(boundary)--\r\n")
        request.httpBody = body

        let (data, response) = try await Self.stagingSession.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw StagingUploadError(
                status: http.statusCode,
                retryAfter: (http.value(forHTTPHeaderField: "Retry-After"))
                    .flatMap(TimeInterval.init)
            )
        }
        return try JSONDecoder().decode(StagedPhotoUpload.self, from: data)
    }

    // MARK: - US-2374: phone → desktop handoff

    private struct HandoffBody: Encodable {
        let stagingSessionId: String
        let source: String
        let photos: [HandoffPhotoPayload]
        let groups: [HandoffGroupPayload]
    }

    /// Park the staged photos + grouping for the desktop AutoLister. Runs no AI
    /// and creates no inventory rows — it hands over the pre-generation state.
    func createHandoffSession(
        stagingSessionId: String,
        photos: [HandoffPhotoPayload],
        groups: [HandoffGroupPayload]
    ) async throws -> HandoffSessionResponse {
        try await api.postJSON(
            "/api/flipdesk/autolister/sessions",
            body: HandoffBody(
                stagingSessionId: stagingSessionId,
                source: "ios",
                photos: photos,
                groups: groups
            )
        )
    }

    private static let stagingSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 60
        return URLSession(configuration: config)
    }()
}
