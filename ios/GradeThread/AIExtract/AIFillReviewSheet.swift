import SwiftData
import SwiftUI

/// Reversible review of an AI auto-fill (US-686). Opened from the item canvas
/// when ``AIFillReviewStore`` holds a pending review for the item. Lets the user:
///   • see which high-confidence fields were auto-applied, and undo any (or all),
///   • opt into the low-confidence suggestions that were intentionally NOT applied,
///   • keep or drop the estimated measurements.
/// All changes are written back to `inventory_items` (with `ai_field_sources`
/// kept consistent) and mirrored onto the local cache.
struct AIFillReviewSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext

    let item: LocalInventoryItem

    @State private var review: AIFillReview?
    /// Applied fields the user is keeping (default: all).
    @State private var keptApplied: Set<String> = []
    /// Low-confidence fields the user has opted into (default: none).
    @State private var acceptedLow: Set<String> = []
    /// Keep the auto-applied measurements (default: as applied).
    @State private var keepMeasurements = true
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if let review {
                    form(review)
                } else {
                    ContentUnavailableView(
                        "Nothing to review",
                        systemImage: "sparkles",
                        description: Text("These AI suggestions have already been reviewed.")
                    )
                }
            }
            .navigationTitle("AI fill")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { finish() }
                        .disabled(isSaving)
                }
            }
        }
        .task { load() }
    }

    // MARK: - Form

    @ViewBuilder
    private func form(_ review: AIFillReview) -> some View {
        Form {
            if review.usedLiveTextFallback {
                liveTextBanner
            }
            if let summary = review.conditionSummary, !summary.isEmpty {
                Section("Condition summary") {
                    Text(summary).font(.body)
                }
            }
            if !review.applied.isEmpty {
                appliedSection(review)
            }
            if !review.lowConfidence.isEmpty {
                lowConfidenceSection(review)
            }
            if !review.measurements.isEmpty {
                measurementsSection(review)
            }
            if let errorMessage {
                Section {
                    Label(errorMessage, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
            actionsSection(review)
        }
    }

    private var liveTextBanner: some View {
        Section {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "text.viewfinder")
                    .font(.system(size: 18))
                    .foregroundStyle(Color.brandNavy)
                VStack(alignment: .leading, spacing: 2) {
                    Text("On-device OCR filled in the gaps")
                        .font(.subheadline.weight(.semibold))
                    Text("AI couldn't read the tag confidently. The suggestions below came from iOS Live Text — double-check before opting in.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func appliedSection(_ review: AIFillReview) -> some View {
        Section {
            ForEach(review.applied) { field in
                Button {
                    toggle(&keptApplied, field.field)
                } label: {
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: keptApplied.contains(field.field) ? "checkmark.circle.fill" : "circle")
                            .scaledIconFont(size: 22)
                            .foregroundStyle(keptApplied.contains(field.field) ? Color.brandNavy : .secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(field.displayLabel)
                                .font(.subheadline.weight(.semibold))
                            Text(field.value)
                                .font(.body)
                                .foregroundStyle(.primary)
                            if !keptApplied.contains(field.field) {
                                Text(undoHint(for: field))
                                    .font(.caption)
                                    .foregroundStyle(Color.brandAmber)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        } header: {
            Text("AI filled these")
        } footer: {
            Text("Uncheck a field to undo its AI fill — it's restored to what it was before.")
                .font(.caption)
        }
    }

    private func lowConfidenceSection(_ review: AIFillReview) -> some View {
        Section {
            ForEach(review.lowConfidence) { entry in
                FieldSuggestionRow(
                    entry: entry,
                    isAccepted: acceptedLow.contains(entry.field)
                ) {
                    toggle(&acceptedLow, entry.field)
                }
            }
        } header: {
            Text("Suggestions to review")
        } footer: {
            Text("Lower-confidence suggestions weren't applied automatically. Check any you want to add.")
                .font(.caption)
        }
    }

    private func measurementsSection(_ review: AIFillReview) -> some View {
        Section {
            Toggle(isOn: $keepMeasurements) {
                Text(keepMeasurements ? "Keep measurements" : "Measurements removed")
                    .font(.subheadline.weight(.semibold))
            }
            .tint(Color.brandNavy)

            ForEach(review.measurements) { measurement in
                HStack {
                    Text(measurement.key.capitalized).font(.subheadline)
                    Spacer()
                    Text(String(format: "%.1f in", measurement.valueInches))
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.secondary)
                }
                .opacity(keepMeasurements ? 1 : 0.4)
            }
        } header: {
            Text("Measurements (estimated)")
        } footer: {
            Text("Brand-spec estimates from the size tag, not a measurement of this garment. Turn off to remove them.")
                .font(.caption)
        }
    }

    private func actionsSection(_ review: AIFillReview) -> some View {
        Section {
            Button {
                Task { await apply(review) }
            } label: {
                HStack(spacing: 6) {
                    if isSaving { ProgressView().tint(.white) }
                    Text("Apply changes")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .background(Color.brandNavy)
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
            }
            .disabled(isSaving)
            .listRowInsets(.init(top: 6, leading: 16, bottom: 6, trailing: 16))

            if !review.applied.isEmpty || review.measurementsApplied {
                Button(role: .destructive) {
                    Task { await undoAll(review) }
                } label: {
                    Label("Undo AI fill", systemImage: "arrow.uturn.backward")
                        .frame(maxWidth: .infinity)
                }
                .disabled(isSaving)
            }
        } footer: {
            Text("“Apply changes” keeps the checked fields and undoes the rest. “Undo AI fill” reverts everything the AI added.")
                .font(.caption)
        }
    }

    private func undoHint(for field: AppliedAIField) -> String {
        if let previous = field.previousValue?.trimmingCharacters(in: .whitespacesAndNewlines),
           !previous.isEmpty {
            return "Will revert to “\(previous)”"
        }
        return "Will be cleared"
    }

    // MARK: - Lifecycle

    private func load() {
        guard let stored = AIFillReviewStore.shared.review(for: item.id) else {
            review = nil
            return
        }
        review = stored
        keptApplied = Set(stored.applied.map(\.field))
        acceptedLow = []
        keepMeasurements = stored.measurementsApplied
    }

    private func finish() {
        AIFillReviewStore.shared.clear(for: item.id)
        dismiss()
    }

    // MARK: - Mutations

    /// Keeps the checked fields, undoes the rest, and opts into accepted
    /// low-confidence suggestions — all in a server write plus local mirror.
    private func apply(_ review: AIFillReview) async {
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }

        let unkept = review.applied.filter { !keptApplied.contains($0.field) }
        let acceptedLowEntries = review.lowConfidence.filter { acceptedLow.contains($0.field) }
        let dropMeasurements = review.measurementsApplied && !keepMeasurements

        // Authoritative ai_field_sources for everything still AI-attributed.
        var finalSources: [String: AIItemFieldWriter.SourceEntry] = [:]
        for field in review.applied where keptApplied.contains(field.field) {
            finalSources[field.field] = .init(source: field.source, confidence: field.confidence, accepted: true)
        }
        for entry in acceptedLowEntries {
            finalSources[entry.field] = .init(source: entry.source, confidence: entry.confidence, accepted: true)
        }
        if review.measurementsApplied && keepMeasurements {
            for measurement in review.measurements {
                finalSources["measurements.\(measurement.key)"] = .init(source: "photo:tag", confidence: 0.7, accepted: true)
            }
        }
        let anyRemaining = !finalSources.isEmpty

        do {
            // 1) Revert unkept columns + drop measurements if turned off. Clear
            //    the AI bookkeeping only when nothing AI-attributed remains.
            let revertColumns = Dictionary(uniqueKeysWithValues: unkept.map { ($0.field, $0.previousValue) })
            if !revertColumns.isEmpty || dropMeasurements || !anyRemaining {
                try await AIItemFieldWriter.revert(
                    itemId: item.id,
                    columns: revertColumns,
                    clearMeasurements: dropMeasurements,
                    clearAISources: !anyRemaining
                )
            }
            // 2) Write newly accepted low-confidence values + authoritative
            //    sources (measurements were already persisted at intake).
            if anyRemaining {
                try await AIItemFieldWriter.write(
                    itemId: item.id,
                    fields: acceptedLowEntries.map { (field: $0.field, value: $0.value) },
                    measurements: nil,
                    sources: finalSources,
                    seedTitle: false
                )
            }
        } catch {
            errorMessage = "Couldn't save: \(error.localizedDescription)"
            HapticFeedback.error()
            return
        }

        // Local mirror: kept applied keep their value, unkept revert, accepted
        // low-conf take their value.
        for field in review.applied {
            applyLocal(field: field.field, value: keptApplied.contains(field.field) ? field.value : field.previousValue)
        }
        for entry in acceptedLowEntries {
            applyLocal(field: entry.field, value: entry.value)
        }
        if dropMeasurements { item.measurementsJSON = nil }
        commitLocal()
        finish()
    }

    /// Reverts every AI-added field + measurements back to the pre-fill state.
    private func undoAll(_ review: AIFillReview) async {
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }

        let revertColumns = Dictionary(uniqueKeysWithValues: review.applied.map { ($0.field, $0.previousValue) })
        do {
            try await AIItemFieldWriter.revert(
                itemId: item.id,
                columns: revertColumns,
                clearMeasurements: review.measurementsApplied,
                clearAISources: true
            )
        } catch {
            errorMessage = "Couldn't undo: \(error.localizedDescription)"
            HapticFeedback.error()
            return
        }

        for field in review.applied {
            applyLocal(field: field.field, value: field.previousValue)
        }
        if review.measurementsApplied { item.measurementsJSON = nil }
        commitLocal()
        finish()
    }

    // MARK: - Local cache

    /// Mirrors a field change onto the local item for the subset of columns the
    /// model stores; the rest self-heal on the next sync pull.
    private func applyLocal(field: String, value: String?) {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        let nonEmpty = (trimmed?.isEmpty == false) ? trimmed : nil
        switch field {
        case "title":    if let nonEmpty { item.title = nonEmpty }
        case "brand":    item.brand = nonEmpty
        case "size":     item.size = nonEmpty
        case "color":    item.color = nonEmpty
        case "material": item.material = nonEmpty
        default:         break
        }
    }

    private func commitLocal() {
        item.updatedAt = .now
        try? modelContext.save()
        HapticFeedback.success()
        NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
    }

    // MARK: - Helpers

    private func toggle(_ set: inout Set<String>, _ key: String) {
        if set.contains(key) { set.remove(key) } else { set.insert(key) }
    }
}
