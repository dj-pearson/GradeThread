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

    private static let waitTimeoutSeconds: Double = 60

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

        if isOffline {
            phases[itemId] = .failed(
                "You're offline. Reconnect and reopen this item to let AI read your photos — they're saved and waiting."
            )
            return
        }

        let store = AIExtractStore()
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

        guard !extractPhotos.isEmpty else {
            phases[itemId] = .failed("No photos uploaded yet — can't read them. Try again once uploads finish.")
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
            let liveText = await liveTextSuggestions(photos: photos)
            if !liveText.isEmpty {
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
            } else {
                phases[itemId] = .failed(error.errorDescription ?? "Unknown error")
                return
            }
        } catch {
            phases[itemId] = .failed(error.localizedDescription)
            return
        }

        await finish(itemId: itemId, store: store)
        phases[itemId] = .ready
    }

    /// Polls the upload store until every queued photo lands in a terminal
    /// state (or times out). Failed uploads are fine — we just skip them.
    private func waitForUploads(
        itemId: String,
        photos: [(slot: PhotoSlotType, capture: PhotoCapture)],
        uploadStore: PhotoUploadStore
    ) async {
        let deadline = Date.now.addingTimeInterval(Self.waitTimeoutSeconds)
        while Date.now < deadline {
            let allTasks = uploadStore.tasks(inventoryItemId: itemId)
            let complete = allTasks.filter { $0.isTerminal }.count
            let total = max(allTasks.count, photos.count)
            if total > 0, complete >= total { return }
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
        guard let image = await Task.detached(priority: .userInitiated, operation: {
            UIImage(data: imageData)
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
