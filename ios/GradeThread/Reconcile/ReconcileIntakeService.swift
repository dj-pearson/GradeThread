import Foundation
import Supabase

/// One staged photo's metadata as persisted into a reconcile session's
/// `assignments` JSONB (US-289). Field names + shape mirror the web's
/// `ReconcileAssignmentSnapshot` exactly so the web board can open the session,
/// hydrate previews from `storagePath`, cluster, and commit.
struct ReconcileSnapshotEntry: Encodable, Equatable {
    let id: String
    let capturedAt: String?
    let name: String
    let clusterId: String?
    let manual: Bool
    let storagePath: String
    let photoType: String

    init(
        id: String,
        capturedAt: Date?,
        name: String,
        storagePath: String,
        photoType: String = "detail"
    ) {
        self.id = id
        self.capturedAt = capturedAt.map { Self.iso.string(from: $0) }
        self.name = name
        // iOS only stages; the web board does the clustering.
        self.clusterId = nil
        self.manual = false
        self.storagePath = storagePath
        self.photoType = photoType
    }

    enum CodingKeys: String, CodingKey {
        case id, capturedAt, name, clusterId, manual, storagePath, photoType
    }

    // Encode nil optionals as explicit JSON null (not omitted) so the JSONB the
    // web board reads always carries `capturedAt`/`clusterId` keys. The
    // synthesized encoder uses `encodeIfPresent` for optionals, which would drop
    // them; use `encode` to force null.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(capturedAt, forKey: .capturedAt)
        try c.encode(name, forKey: .name)
        try c.encode(clusterId, forKey: .clusterId)
        try c.encode(manual, forKey: .manual)
        try c.encode(storagePath, forKey: .storagePath)
        try c.encode(photoType, forKey: .photoType)
    }

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}

/// Creates a reconcile session, stages photos into storage, and records the
/// assignment snapshot — the iOS half of the photo-dump reconcile handoff
/// (US-289). The web board (src/pages/flipdesk/reconcile.tsx) finishes the job.
/// Behind a protocol so ``ReconcileIntakeStore`` is unit-testable.
protocol ReconcileIntakeProviding {
    func createSession(ownerId: String) async throws -> String
    func uploadStagedPhoto(ownerId: String, sessionId: String, photoId: String, jpeg: Data) async throws -> String
    func saveAssignments(sessionId: String, snapshot: [ReconcileSnapshotEntry], photoCount: Int) async throws
}

struct ReconcileIntakeService: ReconcileIntakeProviding {
    enum ServiceError: LocalizedError {
        case noSessionId
        case notSignedIn
        case uploadFailed(status: Int)
        var errorDescription: String? {
            switch self {
            case .noSessionId: return "Couldn't start a reconcile session."
            case .notSignedIn: return "Sign in again to sync photos."
            case .uploadFailed(let status): return "Photo upload failed (\(status))."
            }
        }
    }

    private static let bucket = "item-photos"

    func createSession(ownerId: String) async throws -> String {
        struct NewSession: Encodable {
            let user_id: String
            let gap_seconds: Int
        }
        struct Row: Decodable { let id: String }
        let rows: [Row] = try await SupabaseShared.client
            .from("flipdesk_reconcile_sessions")
            .insert(NewSession(user_id: ownerId, gap_seconds: 30))
            .select("id")
            .execute()
            .value
        guard let id = rows.first?.id else { throw ServiceError.noSessionId }
        return id
    }

    /// Uploads the staged JPEG to the public item-photos bucket under a
    /// per-session folder and returns the storage path. Uses the same raw
    /// `/storage/v1/object` POST the rest of the app uses (PhotoUploadService /
    /// SyncEngine) rather than the SDK, for consistency.
    func uploadStagedPhoto(
        ownerId: String, sessionId: String, photoId: String, jpeg: Data
    ) async throws -> String {
        let path = "\(ownerId)/_reconcile/\(sessionId)/\(photoId).jpg"
        guard let token = await SupabaseShared.currentAccessToken() else {
            throw ServiceError.notSignedIn
        }
        var components = URLComponents(url: AppConfig.supabaseURL, resolvingAgainstBaseURL: false)!
        components.path = "/storage/v1/object/\(Self.bucket)/\(path)"
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        request.setValue("true", forHTTPHeaderField: "x-upsert")
        let (_, response) = try await URLSession.shared.upload(for: request, from: jpeg)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw ServiceError.uploadFailed(status: http.statusCode)
        }
        return path
    }

    func saveAssignments(
        sessionId: String, snapshot: [ReconcileSnapshotEntry], photoCount: Int
    ) async throws {
        struct Update: Encodable {
            let assignments: [ReconcileSnapshotEntry]
            let photo_count: Int
        }
        try await SupabaseShared.client
            .from("flipdesk_reconcile_sessions")
            .update(Update(assignments: snapshot, photo_count: photoCount))
            .eq("id", value: sessionId)
            .execute()
    }
}
