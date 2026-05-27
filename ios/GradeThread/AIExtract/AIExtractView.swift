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
                .font(.headline)
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
                .font(.headline)
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
                .foregroundStyle(.orange)
            Text("AI couldn't read these photos")
                .font(.headline)
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
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
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
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
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
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
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
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
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
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
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
        } catch let error as EdgeAPIError {
            store.fail(error.errorDescription ?? "Unknown error")
        } catch {
            store.fail(error.localizedDescription)
        }
    }

    // MARK: - Apply

    private func applySelected() async {
        guard case let .ready(result) = store.phase else { return }
        isApplying = true
        defer { isApplying = false }

        do {
            try await writeAccepted(result: result)
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
