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

    /// US-1547: the source file's original name (library picks), stamped onto
    /// `item_photos.original_filename` (00339 provenance). nil when unknown.
    public let sourceName: String?

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
        sourceName: String? = nil,
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
        self.sourceName = sourceName
        self.reconcileSessionId = reconcileSessionId
        self.phase = phase
        self.retryCount = retryCount
        self.sessionTaskId = sessionTaskId
    }

    /// Whether the upload reached a genuinely-finished state. `.failed` is
    /// deliberately NOT terminal: a failed upload has queued a pending mutation
    /// to retry, so consumers like `AutoListerGenerator.isItemUploadComplete`
    /// keep the item pending (count it toward a timeout / offer retry) rather
    /// than treating it as done and generating a partial set. The AI-extract
    /// publish gate has its OWN "settled" notion (uploaded/failed/cancelled) so
    /// a single failed photo doesn't block it — see
    /// `AIExtractionManager.waitForRequiredUploads`.
    public var isTerminal: Bool {
        switch phase {
        case .uploaded, .cancelled: return true
        case .queued, .uploading, .failed: return false
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
