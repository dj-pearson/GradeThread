import SwiftUI

/// Runs after photo intake. Waits for pending uploads, calls the edge service
/// for AI suggestions, then — per US-686 — AUTO-APPLIES the high-confidence
/// fields and lands the user straight on the new item. It no longer blocks on a
/// confirm-every-field screen; the reversible review (undo + low-confidence
/// opt-in) lives on the item canvas via ``AIFillReviewStore`` / ``AIFillReviewSheet``.
struct AIExtractView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(PhotoUploadStore.self) private var uploadStore
    /// US-981: short-circuit with friendly copy when offline, instead of waiting
    /// out the upload timeout only to surface a raw network failure.
    @Environment(NetworkMonitor.self) private var networkMonitor: NetworkMonitor?

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
    /// US-826: true while the high-value attribute confirm chips are showing,
    /// after extraction and before auto-apply.
    @State private var confirmingAttributes = false
    /// The user's confirmed high-value attributes, written during auto-apply.
    @State private var confirmedAttributes: [AIAttributeConfirm.Result] = []
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
            if confirmingAttributes {
                // US-826: pause on the high-value confirm chips before writing.
                AIAttributeConfirmView(
                    suggestions: store.attributes,
                    onConfirm: handleAttributeConfirm,
                    onSkip: handleAttributeSkip
                )
            } else {
                // The result is auto-applied in `runFlow`; this is the brief
                // "writing it onto the item" state before we navigate to the canvas.
                applying
            }
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
            // US-1178: don't promise a hard "~10 seconds" — it reads as broken on
            // a slow network. Keep it qualitative.
            Text("This usually only takes a few seconds")
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
        // Offline short-circuit (US-981): the photos sit safely in the upload
        // queue, but the AI extract needs the network — don't spin on uploads
        // that can't finish, just say so plainly.
        if NetworkMonitor.isOffline(networkMonitor) {
            store.fail("You're offline. Reconnect and reopen this item to let AI read your photos — they're saved and waiting.")
            return
        }
        await waitForUploads()
        await runExtract()
        // US-826: if the AI inferred any high-value attributes (department,
        // size type, vintage, condition tier), pause on the confirm chips
        // before auto-applying. The confirm/skip handlers resume the flow.
        if case .ready = store.phase, store.hasAttributesToConfirm {
            confirmingAttributes = true
            return
        }
        await autoApplyIfReady()
    }

    /// US-826: user confirmed the high-value chips — record their decisions and
    /// resume into auto-apply (which writes them after the core fields so the
    /// merged `ai_field_sources` survives).
    private func handleAttributeConfirm(_ results: [AIAttributeConfirm.Result]) {
        confirmedAttributes = results
        confirmingAttributes = false
        Task { await autoApplyIfReady() }
    }

    /// US-826: user skipped the chips — record every AI-suggested high-value
    /// field as rejected (accepted = false) so the model isn't trusted blindly,
    /// then resume.
    private func handleAttributeSkip() {
        confirmedAttributes = AIAttributeConfirm.fields.compactMap { field in
            guard let suggestion = store.attributes[field.key],
                  let first = suggestion.values.first, !first.isEmpty else { return nil }
            return AIAttributeConfirm.Result(
                key: field.key,
                value: nil,
                source: suggestion.source,
                confidence: suggestion.confidence
            )
        }
        confirmingAttributes = false
        Task { await autoApplyIfReady() }
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

        var extractPhotos: [ExtractPhoto] = []
        for entry in photos {
            guard let task = uploadStore.task(for: entry.slot, inventoryItemId: inventoryItemId),
                  case let .uploaded(publicURL) = task.phase
            else { continue }
            // US-979: sensitive slots (tag/grading labels) live in the PRIVATE
            // bucket with no public URL — mint a short-TTL signed URL so the
            // edge (Claude Vision) can still fetch the care label to read
            // brand/size. Public slots use their permanent URL.
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
                    // US-1178: this is the offline Live Text fallback — there was
                    // no server call, so the remaining-action quota is unknown.
                    actionsRemaining: AIExtractResponse.actionsRemainingUnknown
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

        // US-682: seed a usable title from the best available extraction —
        // regardless of confidence — so a no-tag / moderate-confidence capture
        // never lands on a bare "Untitled item" with nothing behind the review.
        let titleSeed = store.bestTitleSeed()

        // Write the confident fields (+ measurements) when there's anything to
        // persist — INCLUDING just a title seed, which the prior guard dropped
        // whenever no field cleared the auto-apply bar (the silent-empty case).
        if !review.applied.isEmpty || review.measurementsApplied || titleSeed != nil {
            do {
                try await writeAutoApplied(review, titleSeed: titleSeed)
            } catch {
                // Persisting failed — DON'T discard the extraction. Fall through
                // to register the review so the user can still apply it from the
                // canvas instead of silently losing everything the AI found.
                Telemetry.breadcrumb(
                    "AI auto-apply write failed: \(error.localizedDescription)",
                    category: "ai-extract"
                )
            }
        }

        // US-686 follow-up: auto-present the review as a sheet (not just a
        // banner) so the extracted fields surface as a dialog the user can act
        // on — the behavior the web's review panel has and users expect.
        if review.hasSomethingToReview {
            AIFillReviewStore.shared.register(review, autoPresent: true)
        }

        // US-826: persist the confirmed high-value attributes LAST so its
        // read-modify-write merges on top of the core-field `ai_field_sources`
        // the auto-apply just wrote (rather than clobbering them). Best-effort.
        if !confirmedAttributes.isEmpty {
            do {
                try await AIItemFieldWriter.writeAttributes(
                    itemId: inventoryItemId,
                    results: confirmedAttributes
                )
            } catch {
                Telemetry.breadcrumb(
                    "AI attribute confirm write failed: \(error.localizedDescription)",
                    category: "ai-extract"
                )
            }
        }

        Telemetry.event(TelemetryEvent.aiExtractUsed, props: [
            "fields_accepted": review.applied.count,
            "measurements_accepted": review.measurementsApplied ? review.measurements.count : 0,
            "auto_applied": true,
            "low_confidence_pending": review.lowConfidence.count,
            "live_text_fallback": review.usedLiveTextFallback,
            "attributes_confirmed": confirmedAttributes.filter { $0.accepted }.count,
            "attributes_rejected": confirmedAttributes.filter { !$0.accepted }.count,
        ])
        complete()
    }

    /// Writes the auto-applied fields + measurements with their `ai_field_sources`.
    /// `titleSeed` lets the caller pass a best-available title (any confidence)
    /// so the row is never left "Untitled item" even when nothing auto-applied.
    private func writeAutoApplied(_ review: AIFillReview, titleSeed: String?) async throws {
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
            seedTitle: true,
            titleSeed: titleSeed
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
        // US-1165: decode the full-res tag JPEG off the main actor (this runs in
        // the @MainActor view) before handing it to the recognizer.
        let imageData = tagEntry.capture.imageData
        guard let image = await Task.detached(priority: .userInitiated, operation: {
            UIImage(data: imageData)
        }).value else {
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
