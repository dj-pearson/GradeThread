import Foundation
import Observation

/// Orchestrates the iOS photo-dump → reconcile-session handoff (US-289):
/// create a session, upload each staged photo to storage, and record the
/// assignment snapshot the web board reads to cluster + finish.
@MainActor
@Observable
final class ReconcileIntakeStore {
    enum Phase: Equatable {
        case idle
        case syncing(done: Int, total: Int)
        case completed(count: Int)
        case failed(String)
    }

    private let service: ReconcileIntakeProviding
    private let ownerId: String

    var phase: Phase = .idle

    init(ownerId: String, service: ReconcileIntakeProviding = ReconcileIntakeService()) {
        self.ownerId = ownerId
        self.service = service
    }

    var isSyncing: Bool { if case .syncing = phase { return true }; return false }

    /// Uploads the staged captures into a fresh reconcile session. Each capture
    /// carries its original `capturedAt` (read before EXIF stripping, US-289) so
    /// the web board's time-gap clustering works. Returns the session id on
    /// success.
    @discardableResult
    func sync(_ captures: [PhotoCapture]) async -> String? {
        guard !captures.isEmpty else { return nil }
        // US-1407: a double-tap or retry-during-upload must not interleave two
        // upload loops — both would write `phase = .syncing(...)`, stranding the
        // progress counter and creating a duplicate reconcile session.
        guard !isSyncing else { return nil }
        phase = .syncing(done: 0, total: captures.count)
        do {
            let sessionId = try await service.createSession(ownerId: ownerId)
            var snapshot: [ReconcileSnapshotEntry] = []
            var done = 0
            for capture in captures {
                // Lowercased to match Postgres `uuid` normalization (the rest of
                // the photo pipeline lowercases ids for the same reason).
                let photoId = UUID().uuidString.lowercased()
                let path = try await service.uploadStagedPhoto(
                    ownerId: ownerId,
                    sessionId: sessionId,
                    photoId: photoId,
                    jpeg: capture.imageData
                )
                snapshot.append(
                    ReconcileSnapshotEntry(
                        id: photoId,
                        capturedAt: capture.capturedAt,
                        name: "\(photoId).jpg",
                        storagePath: path
                    )
                )
                done += 1
                phase = .syncing(done: done, total: captures.count)
            }
            try await service.saveAssignments(
                sessionId: sessionId, snapshot: snapshot, photoCount: snapshot.count
            )
            phase = .completed(count: snapshot.count)
            return sessionId
        } catch {
            phase = .failed((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
            return nil
        }
    }
}
