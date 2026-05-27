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
        self.phase = phase
        self.retryCount = retryCount
        self.sessionTaskId = sessionTaskId
    }

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
