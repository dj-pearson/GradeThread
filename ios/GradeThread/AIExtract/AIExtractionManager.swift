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

    func isRunning(_ itemId: String) -> Bool {
        if case .running = phases[itemId] { return true }
        return false
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
        photos: [(slot: PhotoSlotType, capture: PhotoCapture)],
        uploadStore: PhotoUploadStore,
        isOffline: Bool
    ) {
        guard tasks[itemId] == nil else { return }
        phases[itemId] = .running
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

    // MARK: - Run

    private func run(
        itemId: String,
        userId _: String,
        photos: [(slot: PhotoSlotType, capture: PhotoCapture)],
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

        await waitForUploads(itemId: itemId, photos: photos, uploadStore: uploadStore)

        // Build the extract request from whatever uploaded so far.
        var extractPhotos: [ExtractPhoto] = []
        for entry in photos {
            guard let task = uploadStore.task(for: entry.slot, inventoryItemId: itemId),
                  case let .uploaded(publicURL) = task.phase
            else { continue }
            let url: String
            if entry.slot.isSensitive {
                guard let signed = await PhotoSignedURLProvider.shared.signedURL(
                    bucket: entry.slot.storageBucket,
                    path: task.storagePath
                ) else { continue }
                url = signed.absoluteString
            } else {
                guard !publicURL.isEmpty else { continue }
                url = publicURL
            }
            extractPhotos.append(ExtractPhoto(url: url, type: entry.slot.serverPhotoType))
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

        let request = AIExtractRequest(itemId: itemId, photos: extractPhotos, knownFields: nil, text: nil)
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
    private func waitForUploads(
        itemId: String,
        photos: [(slot: PhotoSlotType, capture: PhotoCapture)],
        uploadStore: PhotoUploadStore
    ) async {
        let start = Date.now
        let deadline = start.addingTimeInterval(Self.waitTimeoutSeconds)
        while Date.now < deadline {
            let allTasks = uploadStore.tasks(inventoryItemId: itemId)
            let registeredAll = allTasks.count >= photos.count
            let allTerminal = allTasks.allSatisfy { $0.isTerminal }
            let graceElapsed = Date.now.timeIntervalSince(start) >= Self.uploadRegisterGraceSeconds
            // Return once every expected task is registered and terminal. When
            // the task list is still empty (e.g. nothing to upload) require the
            // grace to elapse first so we don't return on a vacuously-terminal
            // empty list during the enqueue window.
            if registeredAll, allTerminal, !allTasks.isEmpty || graceElapsed { return }
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
        photos: [(slot: PhotoSlotType, capture: PhotoCapture)],
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
        photos: [(slot: PhotoSlotType, capture: PhotoCapture)],
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
        photos: [(slot: PhotoSlotType, capture: PhotoCapture)]
    ) async -> [String: FieldSuggestion] {
        guard let tagEntry = photos.first(where: { $0.slot == .tag }) else { return [:] }
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
