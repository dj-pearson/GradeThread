import SwiftUI

/// Runs after photo intake. Waits for pending uploads, calls the edge service
/// for AI suggestions, then — per US-686 — AUTO-APPLIES the high-confidence
/// fields and lands the user straight on the new item. It no longer blocks on a
/// confirm-every-field screen; the reversible review (undo + low-confidence
/// opt-in) lives on the item canvas via ``AIFillReviewStore`` / ``AIFillReviewSheet``.
struct AIExtractView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(PhotoUploadStore.self) private var uploadStore

    let inventoryItemId: String
    let userId: String
    /// Captured photos in their final upload slots. Used to send the
    /// extract request even if some uploads are still in flight when the
    /// user opens this screen.
    let photos: [(slot: PhotoSlotType, capture: PhotoCapture)]
    /// Invoked after the flow finishes (auto-apply, Skip, or error fallback).
    let onComplete: () -> Void

    @State private var store = AIExtractStore()
    @State private var service = AIExtractService()
    @State private var isApplying = false
    private static let waitTimeoutSeconds: Double = 60

    var body: some View {
        NavigationStack {
            content
                .background(Color(uiColor: .systemGroupedBackground).ignoresSafeArea())
                .navigationTitle("AI suggestions")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { toolbarContent }
                .task { await runFlow() }
        }
        .interactiveDismissDisabled(isApplying)
    }

    // MARK: - Phase routing

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .waitingForUploads(let complete, let total):
            waiting(complete: complete, total: total)
        case .extracting:
            extracting
        case .ready:
            // The result is auto-applied in `runFlow`; this is just the brief
            // "writing it onto the item" state before we navigate to the canvas.
            applying
        case .failed(let message):
            failed(message: message)
        }
    }

    // MARK: - Loading / transitional states

    private func waiting(complete: Int, total: Int) -> some View {
        VStack(spacing: 14) {
            ProgressView().tint(Color.brandNavy)
            Text("Uploading photos…")
                .font(.brandHeadline)
            Text("\(complete) of \(total) ready")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var extracting: some View {
        VStack(spacing: 16) {
            ProgressView().tint(Color.brandNavy).scaleEffect(1.4)
            Text("AI is reading your photos…")
                .font(.brandHeadline)
            Text("~10 seconds")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            // Animated progress dots — gives a sense of motion while the
            // request is in flight so the screen doesn't feel stuck.
            ProgressDots()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var applying: some View {
        VStack(spacing: 14) {
            ProgressView().tint(Color.brandNavy).scaleEffect(1.2)
            Text("Applying AI suggestions…")
                .font(.brandHeadline)
            Text("Taking you to your item")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func failed(message: String) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 38, weight: .light))
                .foregroundStyle(Color.brandAmber)
            Text("AI couldn't read these photos")
                .font(.brandHeadline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)

            Button {
                complete()
            } label: {
                Text("Skip — I'll fill in manually")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 12)
                    .background(Color.brandNavy)
                    .clipShape(Capsule())
            }
            .padding(.top, 8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Close") { complete() }
                .disabled(isApplying)
        }
    }

    // MARK: - Flow

    private func runFlow() async {
        await waitForUploads()
        await runExtract()
        await autoApplyIfReady()
    }

    /// Polls the upload store until every queued photo for this item lands
    /// in a terminal state. We don't gate on success — failed photos are
    /// fine for the extract call (we just skip them); the user can retry
    /// uploads after the AI step.
    private func waitForUploads() async {
        let deadline = Date.now.addingTimeInterval(Self.waitTimeoutSeconds)
        while Date.now < deadline {
            let allTasks = uploadStore.tasks(inventoryItemId: inventoryItemId)
            let complete = allTasks.filter { $0.isTerminal }.count
            let total = max(allTasks.count, photos.count)
            store.setWaiting(complete: complete, total: total)
            if total > 0, complete >= total { return }
            // Short poll cadence so the count updates fluidly; cheap because
            // each tick just reads MainActor state.
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        // Timed out — let the extract attempt run anyway with whatever
        // succeeded so far. The user can re-extract if results are thin.
    }

    private func runExtract() async {
        store.beginExtract()

        let extractPhotos: [ExtractPhoto] = photos.compactMap { entry in
            guard let task = uploadStore.task(for: entry.slot, inventoryItemId: inventoryItemId),
                  case let .uploaded(publicURL) = task.phase
            else { return nil }
            return ExtractPhoto(url: publicURL, type: entry.slot.serverPhotoType)
        }

        guard !extractPhotos.isEmpty else {
            store.fail("No photos uploaded yet — can't read them. Try again once uploads finish.")
            return
        }

        let request = AIExtractRequest(
            itemId: inventoryItemId,
            photos: extractPhotos,
            knownFields: nil,
            text: nil
        )
        do {
            let response = try await service.extract(request)
            store.applyResponse(response)
            await runLiveTextFallbackIfNeeded()
        } catch let error as EdgeAPIError {
            // AI extract failed — try the on-device fallback as a
            // last-resort source for brand + size so the user still gets
            // *something* pre-filled before falling back to the manual
            // form. These are low-confidence (0.4), so they're never
            // auto-applied — they surface as opt-in suggestions on the canvas.
            let liveText = await liveTextSuggestions()
            if !liveText.isEmpty {
                let synthetic = AIExtractResponse(
                    suggestions: liveText,
                    conditionSummary: nil,
                    conflicts: [],
                    measurements: nil,
                    model: nil,
                    logId: nil,
                    actionsRemaining: -1
                )
                store.applyResponse(synthetic)
                store.liveTextFallbackUsed = true
            } else {
                store.fail(error.errorDescription ?? "Unknown error")
            }
        } catch {
            store.fail(error.localizedDescription)
        }
    }

    /// US-686: auto-apply the high-confidence fields, register the reversible
    /// review for the canvas, and navigate. Low-confidence suggestions are
    /// carried into the review for opt-in rather than blocking here.
    private func autoApplyIfReady() async {
        guard case .ready = store.phase else { return }
        isApplying = true

        // Capture pre-fill values so the canvas undo restores them.
        let snapshot = (try? await AIItemFieldWriter.snapshot(itemId: inventoryItemId))
            ?? AIItemFieldWriter.Snapshot()
        guard let review = store.buildFillReview(itemId: inventoryItemId, snapshot: snapshot) else {
            complete()
            return
        }

        // Write the confident fields (+ measurements) when there's anything to
        // persist. A review with only low-confidence suggestions writes nothing.
        if !review.applied.isEmpty || review.measurementsApplied {
            do {
                try await writeAutoApplied(review)
            } catch {
                // Persisting failed — keep the user moving but don't claim a
                // fill happened.
                Telemetry.breadcrumb(
                    "AI auto-apply write failed: \(error.localizedDescription)",
                    category: "ai-extract"
                )
                complete()
                return
            }
        }

        if review.hasSomethingToReview {
            AIFillReviewStore.shared.register(review)
        }
        Telemetry.event(TelemetryEvent.aiExtractUsed, props: [
            "fields_accepted": review.applied.count,
            "measurements_accepted": review.measurementsApplied ? review.measurements.count : 0,
            "auto_applied": true,
            "low_confidence_pending": review.lowConfidence.count,
            "live_text_fallback": review.usedLiveTextFallback,
        ])
        complete()
    }

    /// Writes the auto-applied fields + measurements with their `ai_field_sources`.
    private func writeAutoApplied(_ review: AIFillReview) async throws {
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
                // `measurements.<key>` prefix matches the web's convention so
                // the MeasurementForm renders the "AI" badge per field.
                sources["measurements.\(measurement.key)"] = AIItemFieldWriter.SourceEntry(
                    source: "photo:tag",
                    confidence: 0.7,
                    accepted: true
                )
            }
            measurements = dict
        }
        try await AIItemFieldWriter.write(
            itemId: inventoryItemId,
            fields: fields,
            measurements: measurements,
            sources: sources,
            // US-682: seed a usable title from brand/style so the new item
            // isn't left as "Untitled item".
            seedTitle: true
        )
    }

    /// Ends the flow: notify the parent (which navigates to the canvas) and
    /// dismiss this cover.
    private func complete() {
        isApplying = false
        onComplete()
        dismiss()
    }

    // MARK: - Live Text fallback (US-177)

    /// Runs Live Text on the tag-slot capture when Claude's result is
    /// missing brand or size. No-op when both fields are already
    /// covered.
    private func runLiveTextFallbackIfNeeded() async {
        guard case let .ready(result) = store.phase else { return }
        let hasBrand = result.entries.contains { $0.field == "brand" }
        let hasSize = result.entries.contains { $0.field == "size" }
        guard !(hasBrand && hasSize) else { return }

        let suggestions = await liveTextSuggestions()
        guard !suggestions.isEmpty else { return }

        let brand = hasBrand ? nil : suggestions["brand"]?.value
        let size = hasSize ? nil : suggestions["size"]?.value
        store.mergeLiveTextSuggestions(brand: brand, size: size)
    }

    /// Returns Live-Text-derived brand + size suggestions for the tag
    /// slot, keyed by field name. Empty when no tag photo or the OCR
    /// returned nothing useful.
    private func liveTextSuggestions() async -> [String: FieldSuggestion] {
        guard let tagEntry = photos.first(where: { $0.slot == .tag }) else {
            return [:]
        }
        guard let image = UIImage(data: tagEntry.capture.imageData) else {
            return [:]
        }
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

// MARK: - Progress dots

/// Three animated dots while the extract call is in flight.
///
/// Driven by SwiftUI's `phaseAnimator` rather than a free-running
/// `Timer.publish().autoconnect()`: the phase cursor is owned by the view
/// hierarchy, so the animation is created when the dots appear and torn down
/// (no lingering main-thread wakeups) the moment they leave the screen — i.e.
/// once the extract finishes and the view transitions away.
private struct ProgressDots: View {
    /// Index of the highest lit dot for each phase. Cycles 0 → 1 → 2 → 0…
    private let phases = [0, 1, 2]

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<3) { _ in
                Circle()
                    .fill(Color.secondary.opacity(0.2))
                    .frame(width: 8, height: 8)
            }
        }
        .phaseAnimator(phases) { _, highestLit in
            HStack(spacing: 6) {
                ForEach(0..<3) { idx in
                    Circle()
                        .fill(idx <= highestLit ? Color.brandNavy : Color.secondary.opacity(0.2))
                        .frame(width: 8, height: 8)
                }
            }
        } animation: { _ in
            .easeInOut(duration: 0.4)
        }
    }
}
