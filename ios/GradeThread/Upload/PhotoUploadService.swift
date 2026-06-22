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
///      `/storage/v1/object/{bucket}/{path}` via the background session. The
///      bucket is per-slot (US-979): public `item-photos` for listing imagery,
///      private `submission-images` for sensitive PII / grading-label slots.
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

    private let store: PhotoUploadStore
    private let supabaseClient: SupabaseClient
    private let modelContainer: ModelContainer?

    private var session: URLSession!
    private let sessionDelegate: SessionDelegate

    /// Cancels every in-flight background-session task, then invokes
    /// `completion` on the MainActor once the session has reported them
    /// cancelled. Injectable so ``cancelAll``'s deterministic reset path can be
    /// exercised in tests without a live background URLSession (which CI can't
    /// host hermetically). The default drives the real session.
    var cancelInFlightTasks: (@escaping @MainActor () -> Void) -> Void = { completion in
        Task { @MainActor in completion() }
    }

    /// `URLSessionTask.taskIdentifier` → our `PhotoUploadTask.id`. Lives
    /// on the MainActor; the delegate only ever passes the int identifier
    /// across the actor boundary, never the dict itself, which keeps the
    /// access pattern race-free.
    private(set) var sessionTaskIdToUploadId: [Int: UUID] = [:]

    /// Per-task scheduling metadata: sort_order survives the upload so
    /// the post-upload `item_photos` insert can carry it through.
    private(set) var sortOrderByUploadId: [UUID: Int] = [:]

    /// Set by ``handleBackgroundEvents(completion:)`` so the AppDelegate
    /// can hand us the system's "I woke you to finish this; call me when
    /// done" callback. Cleared in ``didFinishBackgroundEvents()``.
    private var backgroundCompletion: (() -> Void)?

    public init(
        store: PhotoUploadStore,
        supabaseClient: SupabaseClient = SupabaseShared.client,
        modelContainer: ModelContainer? = nil,
        // Defaults to the stable production identifier; tests pass a unique one
        // so each constructed service claims its own background session.
        sessionIdentifier: String = PhotoUploadService.backgroundSessionIdentifier
    ) {
        self.store = store
        self.supabaseClient = supabaseClient
        self.modelContainer = modelContainer

        let delegate = SessionDelegate()
        self.sessionDelegate = delegate

        let config = URLSessionConfiguration.background(
            withIdentifier: sessionIdentifier
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

        // Drive cancellation off the real session: enumerate its in-flight
        // tasks, cancel each, then signal completion on the MainActor once the
        // session has reported them. Set here (not as the stored default)
        // because it needs `self.session`, which only exists post-init.
        self.cancelInFlightTasks = { [weak self] completion in
            guard let self else {
                Task { @MainActor in completion() }
                return
            }
            self.session.getAllTasks { tasks in
                for t in tasks { t.cancel() }
                Task { @MainActor in completion() }
            }
        }
    }

    // MARK: - Public API

    /// Schedules every captured photo for upload. Tasks beyond the
    /// concurrency cap stay queued and start as in-flight tasks finish.
    public func enqueueAll(
        photos: [(slot: PhotoSlotType, capture: PhotoCapture)],
        inventoryItemId: String,
        userId: String,
        reconcileSessionId: String? = nil
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
                sortOrder: offset,
                reconcileSessionId: reconcileSessionId
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
        sortOrder: Int,
        reconcileSessionId: String? = nil
    ) -> UUID? {
        guard let fileURL = writeToTempFile(data: capture.imageData) else { return nil }

        let timestamp = Int(Date.now.timeIntervalSince1970 * 1000)
        // Lowercase the UUID segments: Swift's `UUID.uuidString` is UPPERCASE,
        // but Postgres `auth.uid()::text` (which the item-photos storage RLS
        // policy compares the first path folder against) is lowercase. An
        // uppercase folder fails the policy → 403 "violates row-level security".
        let storagePath = "\(userId.lowercased())/\(inventoryItemId.lowercased())/\(slot.serverPhotoType)_\(timestamp).jpg"

        let task = PhotoUploadTask(
            inventoryItemId: inventoryItemId,
            userId: userId,
            slot: slot,
            storagePath: storagePath,
            localFileURL: fileURL,
            bytes: Int64(capture.imageData.count),
            capturedAt: capture.capturedAt,
            reconcileSessionId: reconcileSessionId
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
        for id in store.tasks.keys {
            store.updatePhase(id, to: .cancelled)
        }
        // Reset deterministically once the session confirms its in-flight
        // tasks are cancelled — NOT after a fixed `Task.sleep`. Tearing the
        // store/id-maps down on the cancellation completion guarantees any
        // final delegate callbacks have already been enumerated, so a
        // sign-out → sign-in can never surface residual upload progress.
        cancelInFlightTasks { [weak self] in
            self?.finalizeCancellation()
        }
    }

    /// Clears all upload state after cancellation has completed. Resets the
    /// store (the source of any on-screen progress), the session→upload id
    /// maps, and the staged temp files.
    private func finalizeCancellation() {
        store.reset()
        sessionTaskIdToUploadId.removeAll()
        sortOrderByUploadId.removeAll()
        cleanupAllTempFiles()
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
                Telemetry.event("photo_upload_failed", props: [
                    "reason": "not_signed_in",
                    "slot": task.slot.serverPhotoType,
                    "item_id": task.inventoryItemId,
                ])
                store.updatePhase(task.id, to: .failed(error: "Not signed in"))
                return
            }

            guard let url = storageURL(for: task.storagePath, bucket: task.slot.storageBucket) else {
                Telemetry.event("photo_upload_failed", props: [
                    "reason": "bad_storage_url",
                    "slot": task.slot.serverPhotoType,
                    "item_id": task.inventoryItemId,
                ])
                store.updatePhase(task.id, to: .failed(error: "Storage isn't configured correctly"))
                return
            }
            var request = URLRequest(url: url)
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

    private func storageURL(for path: String, bucket: String) -> URL? {
        // `/storage/v1/object/{bucket}/{path}` — same shape the web SDK uses.
        // nil if the base URL is misconfigured; the caller routes a `.failed`.
        StorageURL.object(base: AppConfig.supabaseURL, bucket: bucket, path: path)
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
            // The #1 diagnostic for "photos missing → Untitled": a 401/403 here
            // means the storage POST was rejected (expired token / per-user
            // folder RLS), so nothing lands and the AI run has nothing to read.
            Telemetry.event("photo_upload_failed", props: [
                "reason": "http_\(code)",
                "slot": task.slot.serverPhotoType,
                "bucket": task.slot.storageBucket,
                "item_id": task.inventoryItemId,
            ])
            store.updatePhase(id, to: .failed(error: "Storage upload failed (HTTP \(code))"))
            startNextIfPossible()
            return
        }

        Telemetry.event("photo_upload_ok", props: [
            "slot": task.slot.serverPhotoType,
            "item_id": task.inventoryItemId,
        ])

        // Storage upload OK. Finish the second phase — insert the
        // item_photos row — then finalize.
        let sortOrder = sortOrderByUploadId.removeValue(forKey: id) ?? 0
        Task { @MainActor [weak self] in
            let linked = await self?.insertPhotoRow(for: task, sortOrder: sortOrder) ?? false
            // Only discard the staged JPEG once the row is durably linked. If
            // the DB insert failed we queued a pending mutation that re-uploads
            // from this very file on the next sync — deleting it would strand
            // that retry (replay reads `local_file_url`).
            if linked {
                try? FileManager.default.removeItem(at: task.localFileURL)
            }
            self?.startNextIfPossible()
        }
    }

    fileprivate func didFinishBackgroundEvents() {
        let completion = backgroundCompletion
        backgroundCompletion = nil
        completion?()
    }

    // MARK: - DB insert

    /// Deterministic `item_photos.id` for a task — derived from the task's own
    /// UUID so the direct insert and the pending-mutation replay write the SAME
    /// row. Lowercased to match Postgres `uuid` text form (the storage-folder
    /// RLS comparison relies on the same convention).
    static func photoId(for task: PhotoUploadTask) -> String {
        task.id.uuidString.lowercased()
    }

    /// Inserts the `item_photos` row for a finished storage upload. Returns
    /// `true` once the row is durably linked, `false` if the insert failed
    /// (in which case a pending mutation has been queued and the staged JPEG
    /// must be kept on disk for the replay to re-upload).
    @discardableResult
    private func insertPhotoRow(for task: PhotoUploadTask, sortOrder: Int) async -> Bool {
        // US-979: sensitive slots live in the PRIVATE bucket — they get NO
        // permanent public URL. `photo_url` is left empty; display + the edge
        // resolve a short-TTL signed URL from `storage_path` on demand.
        let publicURL = task.slot.isSensitive ? "" : storagePublicURL(for: task.storagePath)
        let row = ItemPhotoInsert(
            id: Self.photoId(for: task),
            inventory_item_id: task.inventoryItemId,
            photo_type: task.slot.serverPhotoType,
            storage_path: task.storagePath,
            photo_url: publicURL,
            sort_order: sortOrder,
            bytes: task.bytes,
            captured_at: task.capturedAt,
            reconcile_session_id: task.reconcileSessionId
        )
        do {
            // Upsert (not insert) keyed on the primary key: if a previous
            // attempt's response was lost after the server committed, this
            // updates that same row instead of creating a duplicate.
            try await supabaseClient
                .from("item_photos")
                .upsert(row)
                .execute()
            store.updatePhase(task.id, to: .uploaded(publicURL: publicURL))
            return true
        } catch {
            // Storage upload succeeded but the DB write failed (e.g. the access
            // token expired between the two phases). Don't rely on the manual
            // retry button — it's gone the moment the user leaves the capture
            // screen. Queue a pending mutation so the next SyncEngine pass
            // re-links the photo automatically (idempotent storage re-upload +
            // upsert by the SAME deterministic id ⇒ no duplicate rows).
            handlePhotoLinkFailure(task: task, message: error.localizedDescription)
            return false
        }
    }

    /// A successful storage upload followed by a failed `item_photos` insert.
    /// Marks the task `.failed` for the UI AND enqueues a pending mutation so
    /// the photo is auto-re-linked on the next sync rather than orphaned.
    func handlePhotoLinkFailure(task: PhotoUploadTask, message: String) {
        store.updatePhase(
            task.id,
            to: .failed(error: "Saved photo, couldn't link it: \(message)")
        )
        enqueuePendingMutation(for: task, message: message)
    }

    private func storagePublicURL(for path: String) -> String {
        // Only ever called for non-sensitive photos, which live in the public
        // bucket; sensitive photos get an empty `photo_url` instead (US-979).
        StorageURL.publicObject(base: AppConfig.supabaseURL, bucket: PhotoStorageBucket.publicBucket, path: path)?
            .absoluteString ?? ""
    }

    // MARK: - Failure handling

    private func handleNetworkFailure(_ task: PhotoUploadTask, message: String) {
        Telemetry.event("photo_upload_failed", props: [
            "reason": "network",
            "slot": task.slot.serverPhotoType,
            "item_id": task.inventoryItemId,
            "message": message,
        ])
        store.updatePhase(task.id, to: .failed(error: message))
        enqueuePendingMutation(for: task, message: message)
    }

    /// ISO-8601 (internet date-time) formatter for the queued captured_at,
    /// matching ``ItemPhotoInsert``'s encoding so replayed + direct uploads
    /// write identical timestamps.
    private static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

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
            // Deterministic row id (the task's own id) so the SyncEngine replay
            // UPSERTs the SAME row the direct insert targeted — a retry after a
            // lost response can't create a second row with a fresh id (the
            // duplicate-photo bug).
            let photo_id: String
            // US-289: carry capture-time + reconcile session so an offline
            // retry doesn't drop them from the item_photos row.
            let captured_at: String?
            let reconcile_session_id: String?
        }
        let payload = Payload(
            inventory_item_id: task.inventoryItemId,
            user_id: task.userId,
            slot: task.slot.rawValue,
            storage_path: task.storagePath,
            local_file_url: task.localFileURL.path,
            photo_id: Self.photoId(for: task),
            captured_at: task.capturedAt.map { Self.iso8601.string(from: $0) },
            reconcile_session_id: task.reconcileSessionId
        )
        guard let data = try? JSONEncoder().encode(payload) else {
            // Can't even encode the replay payload — the upload would be
            // orphaned (blob in storage, no item_photos row, no queued
            // mutation). The task is already `.failed` (caller set it) so the
            // user can retry; breadcrumb it so the orphan isn't *silent*.
            Telemetry.backgroundBreadcrumb(
                "Photo re-link mutation could not be encoded; upload left for manual retry",
                category: "persistence"
            )
            return
        }
        let context = ModelContext(container)
        context.insert(
            LocalPendingMutation(
                kind: .uploadPhoto,
                payload: data,
                targetId: task.inventoryItemId
            )
        )
        // If this save fails the mutation isn't queued, but the task stays in a
        // retryable `.failed` state (set by the caller) and the failure is now
        // recorded — no longer a silent orphan (US-1142).
        context.saveOrLog("enqueuePendingMutation")
        _ = message  // surfaced via .failed phase; keep payload schema lean
    }

    // MARK: - Temp file plumbing

    private func writeToTempFile(data: Data) -> URL? {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("photo-upload-\(UUID().uuidString).jpg")
        do {
            // US-658: encrypt the staged upload JPEG at rest (it can sit in the
            // background upload queue while the device locks).
            try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
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
