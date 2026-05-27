import Foundation
import Supabase
import SwiftData
import UIKit

/// Drives photo uploads against Supabase Storage on a background URLSession
/// so transfers continue if the user switches apps. Up to three concurrent
/// uploads at a time (per US-175 AC).
///
/// Two-phase per task:
///   1. **Storage upload** — JPEG bytes streamed to
///      `/storage/v1/object/item-photos/{path}` via the background session.
///   2. **DB insert** — once upload finishes, an `item_photos` row is
///      inserted via supabase-swift (regular foreground session — fine
///      because the row insert is cheap and the system only wakes us
///      briefly when uploads finish in the background).
///
/// One instance per app launch. Background URLSession requires the
/// identifier stay stable across launches and only one session can claim
/// any given identifier at a time.
@MainActor
public final class PhotoUploadService {
    public static let backgroundSessionIdentifier = "com.gradethread.app.photo-uploads"
    public static let maxConcurrent = 3
    private static let bucket = "item-photos"

    private let store: PhotoUploadStore
    private let supabaseClient: SupabaseClient
    private let modelContainer: ModelContainer?

    private var session: URLSession!
    private let sessionDelegate: SessionDelegate

    /// `URLSessionTask.taskIdentifier` → our `PhotoUploadTask.id`. Lives
    /// on the MainActor; the delegate only ever passes the int identifier
    /// across the actor boundary, never the dict itself, which keeps the
    /// access pattern race-free.
    private var sessionTaskIdToUploadId: [Int: UUID] = [:]

    /// Per-task scheduling metadata: sort_order survives the upload so
    /// the post-upload `item_photos` insert can carry it through.
    private var sortOrderByUploadId: [UUID: Int] = [:]

    /// Set by ``handleBackgroundEvents(completion:)`` so the AppDelegate
    /// can hand us the system's "I woke you to finish this; call me when
    /// done" callback. Cleared in ``didFinishBackgroundEvents()``.
    private var backgroundCompletion: (() -> Void)?

    public init(
        store: PhotoUploadStore,
        supabaseClient: SupabaseClient = SupabaseShared.client,
        modelContainer: ModelContainer? = nil
    ) {
        self.store = store
        self.supabaseClient = supabaseClient
        self.modelContainer = modelContainer

        let delegate = SessionDelegate()
        self.sessionDelegate = delegate

        let config = URLSessionConfiguration.background(
            withIdentifier: Self.backgroundSessionIdentifier
        )
        config.isDiscretionary = false                    // user-initiated, prioritise responsiveness
        config.sessionSendsLaunchEvents = true            // wake the app when transfers finish
        config.allowsCellularAccess = true
        config.shouldUseExtendedBackgroundIdleMode = true

        self.session = URLSession(
            configuration: config,
            delegate: delegate,
            delegateQueue: nil
        )
        delegate.parent = self
    }

    // MARK: - Public API

    /// Schedules every captured photo for upload. Tasks beyond the
    /// concurrency cap stay queued and start as in-flight tasks finish.
    public func enqueueAll(
        photos: [(slot: PhotoSlotType, capture: PhotoCapture)],
        inventoryItemId: String,
        userId: String
    ) {
        // Stable sort_order across re-uploads: required slots in canonical
        // order first, then defects.
        let order = PhotoSlotType.allCases
        let sorted = photos.sorted {
            (order.firstIndex(of: $0.slot) ?? .max) < (order.firstIndex(of: $1.slot) ?? .max)
        }

        for (offset, entry) in sorted.enumerated() {
            schedule(
                capture: entry.capture,
                slot: entry.slot,
                inventoryItemId: inventoryItemId,
                userId: userId,
                sortOrder: offset
            )
        }
    }

    /// Schedules a single capture. Returns the task id so the caller can
    /// pipe progress through to a specific slot view.
    @discardableResult
    public func schedule(
        capture: PhotoCapture,
        slot: PhotoSlotType,
        inventoryItemId: String,
        userId: String,
        sortOrder: Int
    ) -> UUID? {
        guard let fileURL = writeToTempFile(data: capture.imageData) else { return nil }

        let timestamp = Int(Date.now.timeIntervalSince1970 * 1000)
        let storagePath = "\(userId)/\(inventoryItemId)/\(slot.serverPhotoType)_\(timestamp).jpg"

        let task = PhotoUploadTask(
            inventoryItemId: inventoryItemId,
            userId: userId,
            slot: slot,
            storagePath: storagePath,
            localFileURL: fileURL,
            bytes: Int64(capture.imageData.count)
        )
        store.upsert(task)
        sortOrderByUploadId[task.id] = sortOrder
        startNextIfPossible()
        return task.id
    }

    /// Retries a single failed upload. The temp file is expected to still
    /// be on disk — it stays until the upload reaches a terminal state.
    public func retry(_ taskId: UUID) {
        guard var task = store.tasks[taskId], case .failed = task.phase else { return }
        task.phase = .queued
        store.upsert(task)
        store.bumpRetry(taskId)
        startNextIfPossible()
    }

    /// Cancels every in-flight + queued task and clears the store. Wired
    /// to AuthStore.signOut() so the next user doesn't see the previous
    /// user's progress bars.
    public func cancelAll() {
        session.getAllTasks { tasks in
            for t in tasks { t.cancel() }
        }
        for id in store.tasks.keys {
            store.updatePhase(id, to: .cancelled)
        }
        // Reset after a tick so any final delegate callbacks land
        // somewhere visible before being discarded.
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            self?.store.reset()
            self?.sessionTaskIdToUploadId.removeAll()
            self?.sortOrderByUploadId.removeAll()
            self?.cleanupAllTempFiles()
        }
    }

    /// Called from AppDelegate's
    /// `application(_:handleEventsForBackgroundURLSession:completionHandler:)`.
    /// We hold the completion until `urlSessionDidFinishEvents` fires,
    /// then call it on the main queue.
    public func handleBackgroundEvents(completion: @escaping () -> Void) {
        backgroundCompletion = completion
    }

    // MARK: - Scheduling

    /// Starts as many queued tasks as the concurrency cap permits.
    private func startNextIfPossible() {
        let active = store.activeCount()
        guard active < Self.maxConcurrent else { return }

        let queued = store.allTasks.filter {
            if case .queued = $0.phase { return true } else { return false }
        }
        let toStart = queued.prefix(Self.maxConcurrent - active)
        for task in toStart {
            start(task)
        }
    }

    private func start(_ task: PhotoUploadTask) {
        Task { @MainActor in
            guard let accessToken = await SupabaseShared.currentAccessToken() else {
                store.updatePhase(task.id, to: .failed(error: "Not signed in"))
                return
            }

            var request = URLRequest(url: storageURL(for: task.storagePath))
            request.httpMethod = "POST"
            request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
            request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
            request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
            // `x-upsert: true` matches the web client and makes retries
            // idempotent — we never want a 409 on a re-uploaded shot.
            request.setValue("true", forHTTPHeaderField: "x-upsert")

            let upload = session.uploadTask(with: request, fromFile: task.localFileURL)
            sessionTaskIdToUploadId[upload.taskIdentifier] = task.id
            store.setSessionTaskId(task.id, sessionTaskId: upload.taskIdentifier)
            store.updatePhase(task.id, to: .uploading(progress: 0))
            upload.resume()
        }
    }

    private func storageURL(for path: String) -> URL {
        // `/storage/v1/object/{bucket}/{path}` — same shape the web SDK uses.
        var components = URLComponents(
            url: AppConfig.supabaseURL,
            resolvingAgainstBaseURL: false
        )!
        components.path = "/storage/v1/object/\(Self.bucket)/\(path)"
        return components.url!
    }

    // MARK: - Delegate callbacks (entered from a non-isolated bridge)

    fileprivate func didSendBytes(taskIdentifier: Int, total: Int64, expected: Int64) {
        guard let id = sessionTaskIdToUploadId[taskIdentifier],
              let task = store.tasks[id] else { return }
        let progress = expected > 0 ? Double(total) / Double(expected) : 0
        // Don't regress progress if a delegate callback comes in out of
        // order. URLSession delivers in-order per-task, but be defensive.
        if case let .uploading(current) = task.phase, current > progress { return }
        store.updatePhase(id, to: .uploading(progress: min(progress, 0.99)))
    }

    fileprivate func didFinish(taskIdentifier: Int, response: HTTPURLResponse?, error: Error?) {
        guard let id = sessionTaskIdToUploadId.removeValue(forKey: taskIdentifier) else { return }
        guard let task = store.tasks[id] else { return }

        if let error {
            let nsError = error as NSError
            if nsError.code == NSURLErrorCancelled {
                store.updatePhase(id, to: .cancelled)
            } else {
                handleNetworkFailure(task, message: error.localizedDescription)
            }
            startNextIfPossible()
            return
        }

        guard let response, (200..<300).contains(response.statusCode) else {
            let code = response?.statusCode ?? -1
            store.updatePhase(id, to: .failed(error: "Storage upload failed (HTTP \(code))"))
            startNextIfPossible()
            return
        }

        // Storage upload OK. Finish the second phase — insert the
        // item_photos row — then finalize.
        let sortOrder = sortOrderByUploadId.removeValue(forKey: id) ?? 0
        Task { @MainActor [weak self] in
            await self?.insertPhotoRow(for: task, sortOrder: sortOrder)
            try? FileManager.default.removeItem(at: task.localFileURL)
            self?.startNextIfPossible()
        }
    }

    fileprivate func didFinishBackgroundEvents() {
        let completion = backgroundCompletion
        backgroundCompletion = nil
        completion?()
    }

    // MARK: - DB insert

    private func insertPhotoRow(for task: PhotoUploadTask, sortOrder: Int) async {
        struct ItemPhotoInsert: Encodable {
            let inventory_item_id: String
            let photo_type: String
            let storage_path: String
            let photo_url: String
            let sort_order: Int
            let bytes: Int64
        }
        let publicURL = storagePublicURL(for: task.storagePath)
        let row = ItemPhotoInsert(
            inventory_item_id: task.inventoryItemId,
            photo_type: task.slot.serverPhotoType,
            storage_path: task.storagePath,
            photo_url: publicURL,
            sort_order: sortOrder,
            bytes: task.bytes
        )
        do {
            try await supabaseClient
                .from("item_photos")
                .insert(row)
                .execute()
            store.updatePhase(task.id, to: .uploaded(publicURL: publicURL))
        } catch {
            // Storage upload succeeded but the DB insert failed. Surface
            // it as a failure so the user can retry — the retry path will
            // re-attempt the (idempotent) storage upload and re-insert.
            // TODO(US-180): consider a separate PendingMutation kind for
            // the row insert so we don't re-upload bytes on retry.
            store.updatePhase(
                task.id,
                to: .failed(error: "Saved photo, couldn't link it: \(error.localizedDescription)")
            )
        }
    }

    private func storagePublicURL(for path: String) -> String {
        var components = URLComponents(
            url: AppConfig.supabaseURL,
            resolvingAgainstBaseURL: false
        )!
        components.path = "/storage/v1/object/public/\(Self.bucket)/\(path)"
        return components.url?.absoluteString ?? ""
    }

    // MARK: - Failure handling

    private func handleNetworkFailure(_ task: PhotoUploadTask, message: String) {
        store.updatePhase(task.id, to: .failed(error: message))
        enqueuePendingMutation(for: task, message: message)
    }

    /// Backs the upload by a `LocalPendingMutation` so the next SyncEngine
    /// pass on a healthy network picks it back up. Mutation payload carries
    /// enough metadata for a clean re-upload.
    private func enqueuePendingMutation(for task: PhotoUploadTask, message: String) {
        guard let container = modelContainer else { return }
        struct Payload: Codable {
            let inventory_item_id: String
            let user_id: String
            let slot: String
            let storage_path: String
            let local_file_url: String
        }
        let payload = Payload(
            inventory_item_id: task.inventoryItemId,
            user_id: task.userId,
            slot: task.slot.rawValue,
            storage_path: task.storagePath,
            local_file_url: task.localFileURL.path
        )
        guard let data = try? JSONEncoder().encode(payload) else { return }
        let context = ModelContext(container)
        context.insert(
            LocalPendingMutation(
                kind: .uploadPhoto,
                payload: data,
                targetId: task.inventoryItemId
            )
        )
        try? context.save()
        _ = message  // surfaced via .failed phase; keep payload schema lean
    }

    // MARK: - Temp file plumbing

    private func writeToTempFile(data: Data) -> URL? {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("photo-upload-\(UUID().uuidString).jpg")
        do {
            try data.write(to: url, options: [.atomic])
            return url
        } catch {
            return nil
        }
    }

    private func cleanupAllTempFiles() {
        let dir = FileManager.default.temporaryDirectory
        let urls = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        for url in urls where url.lastPathComponent.hasPrefix("photo-upload-") {
            try? FileManager.default.removeItem(at: url)
        }
    }
}

// MARK: - Session delegate

/// NSObject because URLSession's delegate API is Objective-C. Stateless —
/// every callback is forwarded to the service on the MainActor.
fileprivate final class SessionDelegate: NSObject,
    URLSessionDataDelegate,
    URLSessionTaskDelegate {

    /// Weak so a destroyed service doesn't keep the delegate alive (and
    /// vice-versa). In practice the service is held by the AppDelegate
    /// for the app lifetime, so the weak ref stays valid.
    weak var parent: PhotoUploadService?

    // MARK: URLSessionTaskDelegate

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64,
        totalBytesExpectedToSend: Int64
    ) {
        let taskId = task.taskIdentifier
        Task { @MainActor [weak parent] in
            parent?.didSendBytes(
                taskIdentifier: taskId,
                total: totalBytesSent,
                expected: totalBytesExpectedToSend
            )
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        let taskId = task.taskIdentifier
        let response = task.response as? HTTPURLResponse
        Task { @MainActor [weak parent] in
            parent?.didFinish(taskIdentifier: taskId, response: response, error: error)
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        Task { @MainActor [weak parent] in
            parent?.didFinishBackgroundEvents()
        }
    }
}
