import Foundation
import Observation

/// Single source of truth for in-flight + recently-finished uploads.
/// SwiftUI views observe this directly to render slot-level progress;
/// ``PhotoUploadService`` mutates it as upload state advances.
@MainActor
@Observable
public final class PhotoUploadStore {
    /// All known tasks, keyed by id. Equatable conformance on
    /// PhotoUploadTask + value-type semantics means SwiftUI invalidates
    /// only the views actually observing a changed task.
    public private(set) var tasks: [UUID: PhotoUploadTask] = [:]

    public init() {}

    // MARK: - Reads

    public var allTasks: [PhotoUploadTask] {
        tasks.values.sorted { $0.createdAt < $1.createdAt }
    }

    public func task(for slot: CaptureSlot, inventoryItemId: String) -> PhotoUploadTask? {
        tasks.values.first {
            $0.slot == slot && $0.inventoryItemId == inventoryItemId
        }
    }

    public func tasks(inventoryItemId: String) -> [PhotoUploadTask] {
        allTasks.filter { $0.inventoryItemId == inventoryItemId }
    }

    /// Snapshot of pending work for a given item — uploads queued or in
    /// flight, but not yet succeeded.
    public func pendingTasks(inventoryItemId: String) -> [PhotoUploadTask] {
        tasks(inventoryItemId: inventoryItemId).filter { task in
            switch task.phase {
            case .queued, .uploading, .failed: return true
            case .uploaded, .cancelled: return false
            }
        }
    }

    public func activeCount() -> Int {
        tasks.values.reduce(0) { $0 + ($1.isActive ? 1 : 0) }
    }

    // MARK: - Writes

    public func upsert(_ task: PhotoUploadTask) {
        tasks[task.id] = task
    }

    public func updatePhase(_ id: UUID, to phase: PhotoUploadTask.Phase) {
        guard var task = tasks[id] else { return }
        task.phase = phase
        tasks[id] = task
    }

    public func bumpRetry(_ id: UUID) {
        guard var task = tasks[id] else { return }
        task.retryCount += 1
        tasks[id] = task
    }

    public func setSessionTaskId(_ id: UUID, sessionTaskId: Int?) {
        guard var task = tasks[id] else { return }
        task.sessionTaskId = sessionTaskId
        tasks[id] = task
    }

    public func remove(_ id: UUID) {
        tasks.removeValue(forKey: id)
    }

    /// Drops everything we know about. Used on sign-out so the next user
    /// doesn't see ghost progress bars.
    public func reset() {
        tasks.removeAll()
    }
}
