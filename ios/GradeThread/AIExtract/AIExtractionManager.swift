import Foundation
import Observation
import UIKit

/// Runs the post-intake AI extraction OFF the view lifecycle so the user can
/// dismiss the processing screen and let it finish in the background (US-686
/// follow-up). Owns one `Task` per item; ``AIExtractView`` is now a thin
/// observer of ``phase(for:)`` and the inventory list shows a status pill.
///
/// On success it auto-applies the high-confidence fields (+ seeds a title) and
/// registers the reversible review with `autoPresent`, exactly as the old
/// in-view flow did — so opening the item later pops the same confirmation
/// review. The separate attribute-confirm chip screen was folded into that
/// review, so the whole flow is headless.
@MainActor
@Observable
final class AIExtractionManager {
    static let shared = AIExtractionManager()
    private init() {}

    enum Phase: Equatable {
        /// Publish gate: the captured photos are being saved to storage + the
        /// `item_photos` table. Held until the REQUIRED photos (front/back) have a
        /// confirmed DB row, so the AI never starts against photos that haven't
        /// landed. `done`/`total` drive the progress UI.
        case uploading(done: Int, total: Int)
        case running
        case ready
        case failed(String)
    }

    /// itemId → current phase. Drives the modal observer + the inventory pill.
    private(set) var phases: [String: Phase] = [:]
    private var tasks: [String: Task<Void, Never>] = [:]

    /// How long to wait for the photo uploads to finish before giving up. The
    /// extraction sends the uploaded photos' URLs, so it can't run until they
    /// land; on a slow connection 60s wasn't enough and the run bailed with
    /// nothing to send, leaving an "Untitled" item (US-686 follow-up).
    private static let waitTimeoutSeconds: Double = 180

    /// Brief window for the asynchronously-enqueued upload tasks to register
    /// before ``waitForUploads`` treats an empty task list as "done".
    private static let uploadRegisterGraceSeconds: Double = 1.5

    /// Long-edge the tag capture is downsampled to before the (slow) `.accurate`
    /// Vision OCR pass — full-res adds latency with no accuracy gain on tag text.
    private static let ocrMaxLongEdge: CGFloat = 1600

    func phase(for itemId: String) -> Phase? { phases[itemId] }

    /// Number of runs currently in flight. Test visibility only: the idempotence
    /// guard in ``start``/``startRerun`` is what stops a double tap from spending
    /// two AI actions, and a no-op is otherwise unobservable from outside.
    var inFlightCount: Int { tasks.count }

    /// US-2270: how long to wait before the FOLLOW-UP item pull that picks up the
    /// server's background eBay category/aspects pass (a second ~20s model call).
    /// Without it the category is persisted but never appears until something else
    /// happens to re-sync — which is why a resolved category looked like a failure.
    /// `var` so tests can shrink it; never changed in the app.
    static var ebayFollowUpPullDelaySeconds: Double = 25

    /// Requests a delayed inventory pull so the background-persisted
    /// `ebay_category_id` / `ebay_aspects` land in the local cache on their own.
    /// Detached from the run's task map: the extract is already finished, and this
    /// must survive the canvas being dismissed.
    ///
    /// Not `private` so a test can drive it directly — the alternative is standing
    /// up the whole network path just to observe one notification.
    func scheduleEbayFollowUpPull() {
        let delay = Self.ebayFollowUpPullDelaySeconds
        Task {
            try? await Task.sleep(nanoseconds: UInt64(max(0, delay) * 1_000_000_000))
            NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
        }
    }

    /// US-1519: compare-before-assign. `phases` is one `@Observable` dictionary,
    /// and @Observable fires on every SET regardless of equality — so the 250ms
    /// upload-gate poll re-rendered every visible InventoryRow 4×/s for up to
    /// 180s even when nothing changed. Writing only on a real transition makes
    /// the idle ticks observation no-ops.
    private func setPhase(_ phase: Phase, for itemId: String) {
        guard phases[itemId] != phase else { return }
        phases[itemId] = phase
    }

    /// True while this item is actively being processed — both the publish/upload
    /// gate AND the AI run — so the inventory "AI processing…" pill stays up across
    /// the whole flow (incl. when the user backgrounds during the upload gate).
    func isRunning(_ itemId: String) -> Bool {
        switch phases[itemId] {
        case .uploading, .running: return true
        case .ready, .failed, .none: return false
        }
    }

    /// Clears tracking for an item (cancels an in-flight run). The persisted
    /// review is independent — clear that via ``AIFillReviewStore``.
    func clear(for itemId: String) {
        tasks[itemId]?.cancel()
        tasks[itemId] = nil
        phases[itemId] = nil
    }

    /// Starts a background-capable extraction. Idempotent — a no-op while one is
    /// already in flight for this item, so re-presenting the view or a re-render
    /// never double-runs (or double-charges) the AI.
    func start(
        itemId: String,
        userId: String,
        photos: [(slot: CaptureSlot, capture: PhotoCapture)],
        uploadStore: PhotoUploadStore,
        isOffline: Bool
    ) {
        guard tasks[itemId] == nil else { return }
        phases[itemId] = .uploading(done: 0, total: photos.count)
        let task = Task { [weak self] in
            guard let self else { return }
            await self.run(
                itemId: itemId,
                userId: userId,
                photos: photos,
                uploadStore: uploadStore,
                isOffline: isOffline
            )
        }
        tasks[itemId] = task
    }

    /// US-2266: re-runs the extract on an item that ALREADY EXISTS, from its
    /// persisted photos — the web composer's "Complete with AI", which iOS had no
    /// equivalent of. Until this, the AI ran exactly once (right after capture),
    /// so a thin first pass or better photos added later left the seller typing
    /// the whole listing by hand.
    ///
    /// Differences from ``start``: there are no in-memory captures, so there's no
    /// upload gate to wait on and no on-device Live Text fallback (that reads the
    /// capture bytes). Everything after the call — auto-apply, the reversible
    /// review, acceptance logging, the inventory pull — is the SAME code path, so
    /// a re-run behaves exactly like a post-capture fill.
    ///
    /// Idempotent per item, like ``start``: a second tap while one is in flight is
    /// a no-op, so a slow connection can't double-spend an AI action.
    func startRerun(
        itemId: String,
        photos: [PersistedPhotoRef],
        knownFields: [String: KnownFieldValue]?,
        text: String?,
        isOffline: Bool
    ) {
        guard tasks[itemId] == nil else { return }
        phases[itemId] = .running
        let task = Task { [weak self] in
            guard let self else { return }
            await self.rerun(
                itemId: itemId,
                photos: photos,
                knownFields: knownFields,
                text: text,
                isOffline: isOffline
            )
        }
        tasks[itemId] = task
    }

    private func rerun(
        itemId: String,
        photos: [PersistedPhotoRef],
        knownFields: [String: KnownFieldValue]?,
        text: String?,
        isOffline: Bool
    ) async {
        let bgTask = UIApplication.shared.beginBackgroundTask(withName: "ai-rerun-\(itemId)")
        defer {
            tasks[itemId] = nil
            if bgTask != .invalid { UIApplication.shared.endBackgroundTask(bgTask) }
        }

        if isOffline {
            phases[itemId] = .failed(
                "You're offline. Reconnect and try again — your photos are already saved."
            )
            return
        }

        let extractPhotos = await AIRerunPhotos.build(from: photos)
        let hasText = !(text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)

        Telemetry.event("ai_extract_rerun_begin", props: [
            "item_id": itemId,
            "rows": photos.count,
            "resolved": extractPhotos.count,
            "has_text": hasText,
        ])

        // The server needs photos OR text. Nothing to send is a user-facing state,
        // not a silent no-op — the canvas surfaces this message.
        guard !extractPhotos.isEmpty || hasText else {
            Telemetry.event("ai_extract_bail", props: [
                "reason": "rerun_no_input",
                "item_id": itemId,
                "rows": photos.count,
            ])
            phases[itemId] = .failed(
                "There's nothing for the AI to read yet. Add a photo or a description, then try again."
            )
            return
        }

        let store = AIExtractStore()
        let request = AIExtractRequest(
            itemId: itemId,
            photos: extractPhotos,
            knownFields: knownFields,
            text: hasText ? text : nil
        )
        do {
            let response = try await AIExtractService().extract(request)
            store.applyResponse(response)
        } catch let error as EdgeAPIError {
            phases[itemId] = .failed(error.errorDescription ?? "Unknown error")
            return
        } catch {
            phases[itemId] = .failed(error.localizedDescription)
            return
        }

        Telemetry.event("ai_extract_succeeded", props: [
            "item_id": itemId,
            "photos_sent": extractPhotos.count,
            "rerun": true,
        ])

        await finish(itemId: itemId, store: store)
        NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
        // US-2270: the eBay category/aspects pass is still running server-side.
        if store.ebayPendingCategory { scheduleEbayFollowUpPull() }
        phases[itemId] = .ready
    }

    // MARK: - Run

    private func run(
        itemId: String,
        userId _: String,
        photos: [(slot: CaptureSlot, capture: PhotoCapture)],
        uploadStore: PhotoUploadStore,
        isOffline: Bool
    ) async {
        // Keep finishing for a short window if the user backgrounds the app
        // mid-extract (the ~40s call would otherwise be suspended).
        let bgTask = UIApplication.shared.beginBackgroundTask(withName: "ai-extract-\(itemId)")
        defer {
            tasks[itemId] = nil
            if bgTask != .invalid { UIApplication.shared.endBackgroundTask(bgTask) }
        }

        Telemetry.event("ai_extract_run_begin", props: [
            "item_id": itemId,
            "captured": photos.count,
            "offline": isOffline,
        ])

        let store = AIExtractStore()

        if isOffline {
            // Offline: the server is unreachable, but on-device OCR can still
            // read the tag for a brand/size, so seed a title from that instead
            // of immediately leaving an "Untitled" item (US-1231). Fall back to
            // .failed only when OCR finds nothing usable. The capture bytes are
            // in memory, so this needs neither network nor finished uploads.
            if await applyLiveTextFallback(photos: photos, store: store) {
                Telemetry.event("ai_extract_offline_livetext", props: ["item_id": itemId])
                await finish(itemId: itemId, store: store)
                NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
                phases[itemId] = .ready
            } else {
                Telemetry.event("ai_extract_bail", props: ["reason": "offline", "item_id": itemId])
                phases[itemId] = .failed(
                    "You're offline. Reconnect and reopen this item to let AI read your photos — they're saved and waiting."
                )
            }
            return
        }

        // Publish gate: hold until the REQUIRED photos (front/back) are confirmed
        // in item_photos, surfacing progress via the `.uploading` phase. Optional
        // photos (detail, measurements, …) keep uploading in the background and
        // are NOT waited on, so a slow/failed optional photo can't stall the AI.
        await waitForRequiredUploads(itemId: itemId, photos: photos, uploadStore: uploadStore)

        // Build the extract request from whatever uploaded so far.
        //
        // Every `continue` below drops a photo the seller deliberately took. That
        // used to be silent, which is why "the AI can't read brands" went
        // undiagnosed for so long — the tag was missing from the request and
        // nothing anywhere said so. Record the reason per dropped slot.
        var extractPhotos: [ExtractPhoto] = []
        var dropped: [String: String] = [:]
        for entry in photos {
            let slotName = entry.slot.serverPhotoType
            guard let task = uploadStore.task(for: entry.slot, inventoryItemId: itemId) else {
                dropped[slotName] = "no_task"
                continue
            }
            guard case let .uploaded(publicURL) = task.phase else {
                dropped[slotName] = "not_uploaded"
                continue
            }
            let url: String
            if entry.slot.isSensitive {
                // Tag/certificate close-ups live in the PRIVATE bucket, so the
                // model needs a signed URL. A failed mint silently cost us the
                // single best photo for brand/size.
                guard let signed = await PhotoSignedURLProvider.shared.signedURL(
                    bucket: entry.slot.storageBucket,
                    path: task.storagePath
                ) else {
                    dropped[slotName] = "sign_failed"
                    continue
                }
                url = signed.absoluteString
            } else {
                guard !publicURL.isEmpty else {
                    dropped[slotName] = "empty_public_url"
                    continue
                }
                url = publicURL
            }
            extractPhotos.append(ExtractPhoto(url: url, type: slotName, role: entry.slot.role))
        }
        if !dropped.isEmpty {
            Telemetry.event("ai_extract_photo_dropped", props: [
                "item_id": itemId,
                "dropped": dropped.map { "\($0.key)=\($0.value)" }.sorted().joined(separator: ","),
                "sent": extractPhotos.count,
                "captured": photos.count,
            ])
        }

        // Diagnostic: how many of the captured photos actually reached the
        // server by the time the wait ended. A short count here is the tell for
        // "AI processing… → Untitled": the uploads didn't finish, so there was
        // nothing to send and the server was never called (US-686 follow-up).
        Telemetry.event("ai_extract_photos_ready", props: [
            "item_id": itemId,
            "ready": extractPhotos.count,
            "captured": photos.count,
        ])

        guard !extractPhotos.isEmpty else {
            // No photo reached the server (failed signed-URL mint, storage PUT,
            // or item_photos link), so the extract endpoint is NEVER called —
            // the tell-tale "Untitled item with nothing in the edge logs"
            // (uploads/DB hit Supabase/Kong, not the edge). Break down the
            // terminal upload states so the underlying failure is diagnosable
            // from telemetry next time.
            let terminal = uploadStore.tasks(inventoryItemId: itemId)
            func count(_ predicate: (PhotoUploadTask) -> Bool) -> Int { terminal.filter(predicate).count }
            Telemetry.event("ai_extract_bail", props: [
                "reason": "no_uploads",
                "item_id": itemId,
                "captured": photos.count,
                "tasks": terminal.count,
                "failed": count { if case .failed = $0.phase { return true }; return false },
                "uploaded": count { if case .uploaded = $0.phase { return true }; return false },
                "cancelled": count { if case .cancelled = $0.phase { return true }; return false },
            ])
            // Degrade like the offline and server-error branches instead of
            // dead-ending on a bare "Untitled" item: on-device OCR can still read
            // the tag for a brand/size from the in-memory capture (no upload
            // needed) and seed a title, so the user lands on a usable item with a
            // review. The photos keep retrying in the background via the queued
            // pending mutations (US-1231 follow-up).
            if await applyLiveTextFallback(photos: photos, store: store) {
                Telemetry.event("ai_extract_no_uploads_livetext", props: ["item_id": itemId])
                await finish(itemId: itemId, store: store)
                NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
                phases[itemId] = .ready
            } else {
                phases[itemId] = .failed(
                    "Your photos didn't finish uploading — check your connection, then tap Try again. They're saved and keep retrying in the background."
                )
            }
            return
        }

        // Required photos are confirmed in the DB — now run the AI itself.
        phases[itemId] = .running

        // US-2268: send what the item already holds. This used to pass
        // knownFields/text as nil, which was wrong even for a just-created row: the
        // user is handed off to the item as soon as the gate clears and this call
        // takes ~20-40s, so anything they typed in the meantime was invisible to
        // the AI — and a suggestion for a field they'd just filled would come back
        // and compete with it. Read the row HERE, not at creation time, so the
        // window is as small as possible. A failed read degrades to photos-only.
        let inputs = AIExtractInputs(
            snapshot: (try? await AIItemFieldWriter.snapshot(itemId: itemId))
                ?? AIItemFieldWriter.Snapshot()
        )
        let request = AIExtractRequest(
            itemId: itemId,
            photos: extractPhotos,
            knownFields: inputs.knownFields,
            text: inputs.text
        )
        do {
            let response = try await AIExtractService().extract(request)
            store.applyResponse(response)
            await runLiveTextFallbackIfNeeded(photos: photos, store: store)
        } catch let error as EdgeAPIError {
            // On a server/transport failure, fall back to on-device OCR for
            // brand+size so the user still gets something to opt into.
            if !(await applyLiveTextFallback(photos: photos, store: store)) {
                phases[itemId] = .failed(error.errorDescription ?? "Unknown error")
                return
            }
        } catch {
            phases[itemId] = .failed(error.localizedDescription)
            return
        }

        Telemetry.event("ai_extract_succeeded", props: [
            "item_id": itemId,
            "photos_sent": extractPhotos.count,
        ])

        await finish(itemId: itemId, store: store)

        // finish() wrote the auto-applied title/fields to the SERVER row only
        // (AIItemFieldWriter hits Supabase, never local SwiftData). Pull so the
        // LOCAL item refreshes — without this the background path leaves the row
        // "Untitled" with no info: its dismiss-time pull ran ~immediately, long
        // before this ~40s extraction's write landed, and nothing else re-syncs.
        NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)

        // US-2270: that pull is too EARLY for the eBay category. The server kicked
        // the category/aspects pass off as a background task (a second ~20s model
        // call) and persists ebay_category_id / ebay_aspects when it lands — well
        // after this. Schedule a follow-up pull so it shows up on its own instead
        // of only appearing whenever the next unrelated sync happens to run.
        if store.ebayPendingCategory { scheduleEbayFollowUpPull() }

        phases[itemId] = .ready
    }

    /// Polls the upload store until every queued photo lands in a terminal
    /// state (or times out). Failed uploads are fine — we just skip them.
    ///
    /// Upload tasks are enqueued asynchronously right after capture, so an early
    /// poll can see FEWER registered tasks than the user captured. We must wait
    /// until every captured photo's task has registered (`allTasks.count >=
    /// photos.count`) AND all of them are terminal — not just until the
    /// already-registered ones settle. The old `complete >= max(allTasks.count,
    /// photos.count)` form could satisfy vacuously while the task list was still
    /// filling in (or empty), sending fewer photos than captured and leaving an
    /// "Untitled" item (US-1231 / US-686 follow-up). A small initial grace gives
    /// the tasks a moment to appear so the first poll can't return on an
    /// empty/partial list.
    /// Publish gate: hold until the REQUIRED photos (front/back) are SETTLED —
    /// each either `.uploaded` (confirmed in item_photos) or terminally failed —
    /// so the AI never starts against photos that haven't landed, while a slow or
    /// failed OPTIONAL photo (detail, measurements, …) never blocks it. Publishes
    /// `.uploading(done:total:)` each tick so the view shows progress.
    ///
    /// "Settled" here intentionally includes `.failed` (unlike `isTerminal`): a
    /// failed required photo stops the wait so the existing handoff retry prompt
    /// can surface it, rather than spinning for the full timeout. Falls back to
    /// the whole captured set when none of the photos is a required slot.
    private func waitForRequiredUploads(
        itemId: String,
        photos: [(slot: CaptureSlot, capture: PhotoCapture)],
        uploadStore: PhotoUploadStore
    ) async {
        // Gate on the REQUIRED slots (front/back) plus every captured TAG.
        //
        // The tag is where brand and size are printed — the two fields sellers
        // reported the AI being worst at. Tags are optional slots, so they used
        // to be excluded from this gate: the extract request was assembled the
        // moment front/back settled, the still-uploading tag had no `.uploaded`
        // phase yet, and the request-builder below silently `continue`d past it.
        // The seller photographed the tag and the model never saw it (edge logs
        // showed photoCount:2, photoTypes:[front,back] on items shot with tags).
        //
        // Waiting costs a few seconds against a call that already takes 20-40s,
        // and the same deadline still applies — a tag that never lands is left
        // behind exactly as before, just no longer by default.
        let gated = photos.map(\.slot).filter { $0.isBlocking || $0.isTagSlot }
        let gateSlots = gated.isEmpty ? photos.map(\.slot) : gated
        let total = photos.count
        let start = Date.now
        let deadline = start.addingTimeInterval(Self.waitTimeoutSeconds)

        func isSettled(_ phase: PhotoUploadTask.Phase) -> Bool {
            switch phase {
            case .uploaded, .failed, .cancelled: return true
            case .queued, .uploading: return false
            }
        }

        while Date.now < deadline {
            let allTasks = uploadStore.tasks(inventoryItemId: itemId)
            let uploaded = allTasks.reduce(0) { acc, t in
                if case .uploaded = t.phase { return acc + 1 }
                return acc
            }
            // US-1519: no-op unless `done` actually advanced — this poll runs
            // 4×/s and used to invalidate every observing row per tick.
            setPhase(.uploading(done: uploaded, total: total), for: itemId)

            let registeredAll = allTasks.count >= total
            let gateSettled = gateSlots.allSatisfy { slot in
                guard let task = uploadStore.task(for: slot, inventoryItemId: itemId) else { return false }
                return isSettled(task.phase)
            }
            let graceElapsed = Date.now.timeIntervalSince(start) >= Self.uploadRegisterGraceSeconds
            // Proceed once the gate photos are settled and every expected task has
            // registered. The grace guard avoids returning on a vacuously-true
            // empty set during the brief async enqueue window.
            if registeredAll, gateSettled, !allTasks.isEmpty || graceElapsed { return }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
    }

    // MARK: - Auto-apply (US-686)

    private func finish(itemId: String, store: AIExtractStore) async {
        guard case .ready = store.phase else { return }

        let snapshot = (try? await AIItemFieldWriter.snapshot(itemId: itemId))
            ?? AIItemFieldWriter.Snapshot()
        guard let review = store.buildFillReview(itemId: itemId, snapshot: snapshot) else { return }

        // Seed a usable title from the best available extraction so the item is
        // never left "Untitled item" (US-682).
        let titleSeed = store.bestTitleSeed()

        if !review.applied.isEmpty || review.measurementsApplied || titleSeed != nil {
            do {
                try await writeAutoApplied(itemId: itemId, review: review, titleSeed: titleSeed)
            } catch {
                // Don't discard the extraction on a transient write failure —
                // the review is still registered below for retry from the canvas.
                Telemetry.breadcrumb(
                    "AI background auto-apply write failed: \(error.localizedDescription)",
                    category: "ai-extract"
                )
            }
        }

        // US-2818: an item that reaches "drafted" with an empty description is
        // not drafted. Fill it from the per-garment listing template now that
        // brand/size/colour/material and the measurements have just been
        // written, so the seller opens a finished draft instead of a blank box
        // and a Generate button. Never overwrites an existing description.
        do {
            try await AIItemFieldWriter.seedDescriptionIfEmpty(itemId: itemId)
        } catch {
            Telemetry.breadcrumb(
                "AI description seed failed: \(error.localizedDescription)",
                category: "ai-extract"
            )
        }

        // US-2818: the AI pass IS the drafting step, so the item ends on
        // `drafted` the way the same item does on the web. It used to stop at
        // `photographed` — iOS derives "drafted" from a `listings` row and the
        // photo-first intake never creates one, so the Drafted tab stayed empty
        // no matter how many items had been through the AI. Forward-only and
        // best-effort: a failure here must not discard the extraction above.
        do {
            let advanced = try await AIItemFieldWriter.advanceStatus(
                itemId: itemId, to: ItemWorkflow.aiDraftedStatus
            )
            if advanced != nil {
                // The local mirror is written by the sync pull, not from here —
                // the manager holds no model context by design (it outlives the
                // views that do).
                NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
            }
        } catch {
            Telemetry.breadcrumb(
                "AI status advance to drafted failed: \(error.localizedDescription)",
                category: "ai-extract"
            )
        }

        // Auto-present the review when the user opens the item.
        if review.hasSomethingToReview {
            AIFillReviewStore.shared.register(review, autoPresent: true)
        }

        Telemetry.event(TelemetryEvent.aiExtractUsed, props: [
            "fields_accepted": review.applied.count,
            "measurements_accepted": review.measurementsApplied ? review.measurements.count : 0,
            "auto_applied": true,
            "low_confidence_pending": review.lowConfidence.count,
            "live_text_fallback": review.usedLiveTextFallback,
            "background": true,
        ])
    }

    /// Writes the auto-applied fields + measurements with their `ai_field_sources`.
    private func writeAutoApplied(itemId: String, review: AIFillReview, titleSeed: String?) async throws {
        var fields: [(field: String, value: String)] = []
        var sources: [String: AIItemFieldWriter.SourceEntry] = [:]
        for field in review.applied {
            fields.append((field: field.field, value: field.value))
            sources[field.field] = AIItemFieldWriter.SourceEntry(
                source: field.source,
                confidence: field.confidence,
                accepted: true
            )
        }
        var measurements: [String: Double]?
        if review.measurementsApplied {
            var dict: [String: Double] = [:]
            for measurement in review.measurements {
                dict[measurement.key] = measurement.valueInches
                sources["measurements.\(measurement.key)"] = AIItemFieldWriter.SourceEntry(
                    source: "photo:tag",
                    confidence: 0.7,
                    accepted: true
                )
            }
            measurements = dict
        }
        try await AIItemFieldWriter.write(
            itemId: itemId,
            fields: fields,
            measurements: measurements,
            sources: sources,
            seedTitle: true,
            titleSeed: titleSeed
        )
    }

    // MARK: - Live Text fallback (US-177)

    /// Runs on-device OCR and, when it finds a brand/size, applies it to `store`
    /// as a synthetic extraction result (seeding a title downstream). Returns
    /// whether anything was applied. Shared by the offline branch and the
    /// server-failure (`EdgeAPIError`) fallback so they degrade identically.
    private func applyLiveTextFallback(
        photos: [(slot: CaptureSlot, capture: PhotoCapture)],
        store: AIExtractStore
    ) async -> Bool {
        let liveText = await liveTextSuggestions(photos: photos)
        guard !liveText.isEmpty else { return false }
        let synthetic = AIExtractResponse(
            suggestions: liveText,
            conditionSummary: nil,
            conflicts: [],
            measurements: nil,
            model: nil,
            logId: nil,
            actionsRemaining: AIExtractResponse.actionsRemainingUnknown
        )
        store.applyResponse(synthetic)
        store.liveTextFallbackUsed = true
        return true
    }

    private func runLiveTextFallbackIfNeeded(
        photos: [(slot: CaptureSlot, capture: PhotoCapture)],
        store: AIExtractStore
    ) async {
        guard case let .ready(result) = store.phase else { return }
        let hasBrand = result.entries.contains { $0.field == "brand" }
        let hasSize = result.entries.contains { $0.field == "size" }
        guard !(hasBrand && hasSize) else { return }

        let suggestions = await liveTextSuggestions(photos: photos)
        guard !suggestions.isEmpty else { return }
        let brand = hasBrand ? nil : suggestions["brand"]?.value
        let size = hasSize ? nil : suggestions["size"]?.value
        store.mergeLiveTextSuggestions(brand: brand, size: size)
    }

    private func liveTextSuggestions(
        photos: [(slot: CaptureSlot, capture: PhotoCapture)]
    ) async -> [String: FieldSuggestion] {
        // US-2470: any TAG slot, whatever role it carries. Matching the bare
        // `.tag` slot missed every profile-driven capture, where the tag shots
        // are `tag:brand` / `tag:size` / `tag:care` — the size tag most of all,
        // which is exactly the photo this OCR pass exists to read.
        guard let tagEntry = photos.first(where: { $0.slot.isTagSlot }) else { return [:] }
        let imageData = tagEntry.capture.imageData
        // Downsample (~1600px long edge) BEFORE the `.accurate` Vision pass: a
        // full-res capture (2048px+) makes accurate OCR crawl with no accuracy
        // gain on tag text, and the decode+resize stays off the main actor
        // (US-1231).
        let maxLongEdge = Self.ocrMaxLongEdge
        guard let image = await Task.detached(priority: .userInitiated, operation: {
            autoreleasepool { () -> UIImage? in
                guard let full = UIImage(data: imageData) else { return nil }
                return PhotoCompressor.resize(full, maxLongEdge: maxLongEdge)
            }
        }).value else { return [:] }
        let recognizer = TagTextRecognizer()
        let lines: [RecognizedLine]
        do {
            lines = try await recognizer.recognize(image)
        } catch {
            return [:]
        }
        let inferred = SizeTagInference.infer(lines: lines.map(\.text))
        var out: [String: FieldSuggestion] = [:]
        if let brand = inferred.brand, !brand.isEmpty {
            out["brand"] = FieldSuggestion(value: brand, confidence: 0.4, source: "live-text")
        }
        if let size = inferred.size, !size.isEmpty {
            out["size"] = FieldSuggestion(value: size, confidence: 0.4, source: "live-text")
        }
        return out
    }
}
