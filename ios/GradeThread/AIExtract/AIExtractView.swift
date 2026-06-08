import SwiftUI
import Supabase

/// Review screen that runs after the photo intake. Waits for pending
/// uploads to land, calls the edge service for AI suggestions, and lets
/// the user accept / dismiss them before they're written onto the
/// freshly-created inventory_items row.
struct AIExtractView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(PhotoUploadStore.self) private var uploadStore

    let inventoryItemId: String
    let userId: String
    /// Captured photos in their final upload slots. Used to send the
    /// extract request even if some uploads are still in flight when the
    /// user opens this screen.
    let photos: [(slot: PhotoSlotType, capture: PhotoCapture)]
    /// Invoked after the user finishes (Apply, Skip, or error fallback).
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
        case .ready(let result):
            review(result: result)
        case .failed(let message):
            failed(message: message)
        }
    }

    // MARK: - Loading states

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
                onComplete()
                dismiss()
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

    // MARK: - Review screen

    private func review(result: AIExtractStore.Result) -> some View {
        ScrollView {
            VStack(spacing: 12) {
                if store.liveTextFallbackUsed {
                    liveTextBanner
                }
                if let summary = result.conditionSummary, !summary.isEmpty {
                    summaryCard(summary)
                }
                fieldsCard(result.entries)
                if !result.measurements.isEmpty {
                    measurementsCard(result.measurements)
                }
                applyRow
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
    }

    private var liveTextBanner: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "text.viewfinder")
                .font(.system(size: 18))
                .foregroundStyle(Color.brandNavy)
            VStack(alignment: .leading, spacing: 2) {
                Text("On-device OCR filled in the gaps")
                    .font(.subheadline.weight(.semibold))
                Text("AI couldn't read the size tag confidently. Lower-confidence suggestions below are from iOS Live Text — double-check before accepting.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(Color.brandNavy.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
    }

    private func summaryCard(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Condition summary", systemImage: "text.alignleft")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(text)
                .font(.body)
                .foregroundStyle(.primary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        // US-691: unified card chrome (radius 16) via the shared token.
        .cardStyle(.flush)
    }

    private func fieldsCard(_ entries: [FieldSuggestionEntry]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Detected fields")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Button("Accept all") { store.acceptAll() }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.brandNavy)
            }
            if entries.isEmpty {
                Text("AI didn't surface any field suggestions.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(entries) { entry in
                    FieldSuggestionRow(
                        entry: entry,
                        isAccepted: store.isAccepted(entry.field)
                    ) {
                        store.toggle(entry.field)
                    }
                    if entry.id != entries.last?.id {
                        Divider()
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        // US-691: unified card chrome (radius 16) via the shared token.
        .cardStyle(.flush)
    }

    private func measurementsCard(_ measurements: [AIExtractStore.Measurement]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Measurements (estimated)", systemImage: "ruler")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Toggle("", isOn: Binding(
                    get: { store.acceptMeasurements },
                    set: { store.acceptMeasurements = $0 }
                ))
                .labelsHidden()
                .toggleStyle(.switch)
                .tint(Color.brandNavy)
            }
            Text("Brand-spec flat measurements. Verify before listing — they're estimates from the size tag, not a measurement of this specific garment.")
                .font(.caption)
                .foregroundStyle(.secondary)

            ForEach(measurements) { measurement in
                HStack {
                    Text(measurement.key.capitalized)
                        .font(.subheadline)
                    Spacer()
                    Text(String(format: "%.1f in", measurement.valueInches))
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        // US-691: unified card chrome (radius 16) via the shared token.
        .cardStyle(.flush)
    }

    private var applyRow: some View {
        HStack(spacing: 12) {
            Button {
                onComplete()
                dismiss()
            } label: {
                Text("Skip")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(Color(uiColor: .secondarySystemBackground))
                    .foregroundStyle(.primary)
                    .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
            }

            Button {
                Task { await applySelected() }
            } label: {
                HStack(spacing: 6) {
                    if isApplying { ProgressView().tint(.white) }
                    Text("Apply selected (\(store.acceptedCount))")
                        .font(.subheadline.weight(.semibold))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(Color.brandNavy)
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
            }
            .disabled(isApplying)
        }
        .padding(.top, 6)
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Close") {
                onComplete()
                dismiss()
            }
            .disabled(isApplying)
        }
    }

    // MARK: - Flow

    private func runFlow() async {
        await waitForUploads()
        await runExtract()
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
            // form. The screen still reads "AI couldn't read these
            // photos" because Claude failed; but if Live Text produced
            // anything we surface it underneath.
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

    // MARK: - Apply

    private func applySelected() async {
        guard case let .ready(result) = store.phase else { return }
        isApplying = true
        defer { isApplying = false }

        do {
            try await writeAccepted(result: result)
            Telemetry.event(TelemetryEvent.aiExtractUsed, props: [
                "fields_accepted": store.acceptedFields.count,
                "measurements_accepted": store.acceptMeasurements ? result.measurements.count : 0,
                "live_text_fallback": store.liveTextFallbackUsed,
            ])
            onComplete()
            dismiss()
        } catch {
            store.fail("Couldn't save your selections: \(error.localizedDescription)")
        }
    }

    private func writeAccepted(result: AIExtractStore.Result) async throws {
        // Build the update payload. Field names map directly to
        // inventory_items columns; the server's enum-typed fields
        // (garment_type / garment_category) accept the suggested string.
        var update = ItemUpdate()
        var sources: [String: AIFieldSourceEntry] = [:]

        for entry in result.entries where store.isAccepted(entry.field) {
            let value = entry.value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty else { continue }
            update.assign(field: entry.field, value: value)
            sources[entry.field] = AIFieldSourceEntry(
                source: entry.source,
                confidence: entry.confidence,
                accepted: true
            )
        }

        if store.acceptMeasurements, !result.measurements.isEmpty {
            var measurementsDict: [String: Double] = [:]
            for measurement in result.measurements {
                measurementsDict[measurement.key] = measurement.valueInches
                // `measurements.<key>` prefix matches the web's
                // ai_field_sources convention so MeasurementForm renders
                // the "AI" badge per field.
                sources["measurements.\(measurement.key)"] = AIFieldSourceEntry(
                    source: "photo:tag",
                    confidence: 0.7,
                    accepted: true
                )
            }
            update.measurements = measurementsDict
        }

        // US-682: seed a usable title from accepted brand/style when the AI
        // didn't surface an explicit title, so the new item isn't left as
        // "Untitled item" and is easy to find back in the list.
        if update.title == nil {
            let seed = [update.brand, update.style ?? update.size]
                .compactMap { $0 }
                .joined(separator: " ")
                .trimmingCharacters(in: .whitespaces)
            if !seed.isEmpty { update.title = seed }
        }

        if !sources.isEmpty {
            update.aiFieldSources = sources
            update.aiEnrichedAt = ISO8601DateFormatter().string(from: .now)
        }

        try await SupabaseShared.client
            .from("inventory_items")
            .update(update)
            .eq("id", value: inventoryItemId)
            .execute()
    }
}

// MARK: - DTOs

/// Encodable subset of `inventory_items` that the apply step writes.
/// Sparse fields stay nil and get skipped by the encoder so we don't
/// overwrite untouched columns.
private struct ItemUpdate: Encodable {
    var title: String?
    var brand: String?
    var size: String?
    var color: String?
    var material: String?
    var style: String?
    var description: String?
    var garmentType: String?
    var garmentCategory: String?
    var itemCategory: String?
    var measurements: [String: Double]?
    var aiFieldSources: [String: AIFieldSourceEntry]?
    var aiEnrichedAt: String?

    private enum CodingKeys: String, CodingKey {
        case title, brand, size, color, material, style, description
        case garmentType = "garment_type"
        case garmentCategory = "garment_category"
        case itemCategory = "item_category"
        case measurements
        case aiFieldSources = "ai_field_sources"
        case aiEnrichedAt = "ai_enriched_at"
    }

    mutating func assign(field: String, value: String) {
        switch field {
        case "title":             title = value
        case "brand":             brand = value
        case "size":              size = value
        case "color":             color = value
        case "material":          material = value
        case "style":             style = value
        case "description":       description = value
        case "garment_type":      garmentType = value
        case "garment_category":  garmentCategory = value
        case "item_category":     itemCategory = value
        default:
            // Unknown field — silently dropped. The web client does the
            // same; if a new field surfaces in suggestions we'll add it
            // here in a later pass.
            break
        }
    }
}

private struct AIFieldSourceEntry: Encodable {
    let source: String
    let confidence: Double
    let accepted: Bool
}

// MARK: - Progress dots

/// Three animated dots while the extract call is in flight.
private struct ProgressDots: View {
    @State private var phase = 0
    private let timer = Timer.publish(every: 0.4, on: .main, in: .common).autoconnect()

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<3) { idx in
                Circle()
                    .fill(idx <= phase ? Color.brandNavy : Color.secondary.opacity(0.2))
                    .frame(width: 8, height: 8)
            }
        }
        .onReceive(timer) { _ in
            phase = (phase + 1) % 3
        }
    }
}
