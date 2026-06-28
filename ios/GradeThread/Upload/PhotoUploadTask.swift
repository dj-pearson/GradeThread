import Foundation

/// One photo's worth of upload state. Each capture (camera or library)
/// becomes exactly one PhotoUploadTask scheduled through
/// ``PhotoUploadService``.
///
/// The task is value-typed so SwiftUI observation diffs cleanly when the
/// phase advances. The owning ``PhotoUploadStore`` re-puts the value back
/// into its dict on every phase change.
public struct PhotoUploadTask: Identifiable, Equatable {
    public let id: UUID
    public let inventoryItemId: String
    public let userId: String
    public let slot: PhotoSlotType
    public let storagePath: String
    public let localFileURL: URL
    public let bytes: Int64
    public let createdAt: Date

    /// Original capture time (PHAsset.creationDate for library picks),
    /// stamped onto `item_photos.captured_at`. nil when unknown.
    public let capturedAt: Date?

    /// Set when this photo was ingested through a Photo Dump Reconciliation
    /// session (US-289). nil for the normal per-item intake flow.
    public let reconcileSessionId: String?

    public var phase: Phase
    public var retryCount: Int

    /// Identifier of the underlying `URLSessionUploadTask`, set when the
    /// service hands the task to the background session. We keep it so
    /// ``PhotoUploadService.cancelAll()`` can match status callbacks to
    /// the right ``PhotoUploadTask`` after process relaunch.
    public var sessionTaskId: Int?

    public enum Phase: Equatable {
        case queued
        case uploading(progress: Double)
        case uploaded(publicURL: String)
        case failed(error: String)
        case cancelled
    }

    public init(
        id: UUID = UUID(),
        inventoryItemId: String,
        userId: String,
        slot: PhotoSlotType,
        storagePath: String,
        localFileURL: URL,
        bytes: Int64,
        createdAt: Date = .now,
        capturedAt: Date? = nil,
        reconcileSessionId: String? = nil,
        phase: Phase = .queued,
        retryCount: Int = 0,
        sessionTaskId: Int? = nil
    ) {
        self.id = id
        self.inventoryItemId = inventoryItemId
        self.userId = userId
        self.slot = slot
        self.storagePath = storagePath
        self.localFileURL = localFileURL
        self.bytes = bytes
        self.createdAt = createdAt
        self.capturedAt = capturedAt
        self.reconcileSessionId = reconcileSessionId
        self.phase = phase
        self.retryCount = retryCount
        self.sessionTaskId = sessionTaskId
    }

    /// Whether this task has reached a state the upload queue won't advance past
    /// on its own. `.failed` IS terminal here: a failed upload has already queued
    /// a `LocalPendingMutation` for the SyncEngine to retry out-of-band, so for
    /// the purposes of "are we still actively uploading?" it's done. This is
    /// load-bearing for `AIExtractionManager.waitForUploads`, whose own comment
    /// says "failed uploads are fine — we just skip them": if `.failed` were
    /// treated as non-terminal, a single failed photo (e.g. an item_photos link
    /// that didn't stick) would block the AI-extract wait for its full 180s
    /// timeout, so extract never fires for the photos that DID upload and the
    /// user sees "couldn't process your photos" with nothing in the edge logs.
    public var isTerminal: Bool {
        switch phase {
        case .uploaded, .cancelled, .failed: return true
        case .queued, .uploading: return false
        }
    }

    public var isActive: Bool {
        if case .uploading = phase { return true }
        return false
    }

    public var progress: Double {
        switch phase {
        case .uploading(let p):    return p
        case .uploaded:            return 1.0
        case .queued, .failed,
             .cancelled:           return 0.0
        }
    }
}
