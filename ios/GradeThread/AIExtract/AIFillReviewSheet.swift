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
    // US-1182: brief on-screen confirmation shown before the sheet dismisses,
    // so a successful apply isn't only a haptic.
    @State private var didApply = false

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
                    // US-1182: a plain dismiss must NOT clear the pending review —
                    // otherwise tapping the only toolbar button after toggling a
                    // field silently discards every edit and destroys the review.
                    // "Cancel" just dismisses; the review stays pending so it can
                    // be reopened. "Apply changes" is the path that consumes it.
                    Button("Cancel") { dismiss() }
                        .disabled(isSaving)
                }
            }
            .overlay(alignment: .bottom) {
                if didApply {
                    Text("Changes applied")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16).padding(.vertical, 10)
                        .background(Color.brandNavy, in: Capsule())
                        .padding(.bottom, 24)
                        .transition(.opacity)
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
            if let ebay = review.ebayCategory {
                ebaySection(ebay)
            } else if review.ebayCategoryPending == true {
                ebayPendingSection
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

    /// US-822: read-only summary of the eBay category + item-specifics the
    /// server resolved and already saved onto the item during extraction. The
    /// dedicated specifics editor (opened from the canvas) is where the user
    /// edits them — this just confirms they were set.
    private func ebaySection(_ ebay: AIFillReview.EbaySummary) -> some View {
        Section {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "tag")
                    .font(.system(size: 18))
                    .foregroundStyle(Color.brandNavy)
                VStack(alignment: .leading, spacing: 2) {
                    Text(ebay.displayName)
                        .font(.subheadline.weight(.semibold))
                    Text(ebay.filledAspectCount > 0
                        ? "\(ebay.filledAspectCount) item specific\(ebay.filledAspectCount == 1 ? "" : "s") filled"
                        : "Category set — add item specifics on the item")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
        } header: {
            Text("eBay category")
        } footer: {
            Text("Auto-selected and saved. Edit the category or its specifics from the item's Specifics section.")
                .font(.caption)
        }
    }

    /// US-2270: the category/aspects pass runs server-side in the BACKGROUND (it's
    /// a second ~20s model call that used to double the extract's latency), so
    /// there's nothing to show inline yet. Saying so beats the old behaviour of
    /// omitting the section entirely, which made a category that WAS being
    /// resolved read as a silent failure.
    private var ebayPendingSection: some View {
        Section {
            HStack(alignment: .top, spacing: 12) {
                ProgressView()
                    .controlSize(.small)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Finding the eBay category…")
                        .font(.subheadline.weight(.semibold))
                    Text("Item specifics are being filled from your photos.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
        } header: {
            Text("eBay category")
        } footer: {
            Text("This finishes on its own — it'll be saved on the item in a moment. You don't have to wait.")
                .font(.caption)
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
                            HStack(spacing: 6) {
                                Text(field.displayLabel)
                                    .font(.subheadline.weight(.semibold))
                                // US-1527: this value is the AI NAMING the
                                // product from its knowledge — badge it so the
                                // user verifies rather than assumes tag text.
                                if field.source == "research" {
                                    Text("Identified")
                                        .font(.caption2.weight(.semibold))
                                        .foregroundStyle(.purple)
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .background(Color.purple.opacity(0.12))
                                        .clipShape(Capsule())
                                }
                            }
                            Text(field.value)
                                .font(.body)
                                .foregroundStyle(.primary)
                            if field.source == "research",
                               let rationale = review.researchRationale,
                               !rationale.isEmpty {
                                Text("Why: \(rationale)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
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
                    isAccepted: acceptedLow.contains(entry.field),
                    onToggle: { toggle(&acceptedLow, entry.field) },
                    // US-1527: research-tier rows disclose the identification
                    // rationale (the row gates on source == "research").
                    researchRationale: review.researchRationale
                )
            }
        } header: {
            Text("Suggestions to review")
        } footer: {
            // US-2267: two reasons a suggestion lands here now — it was below the
            // write bar, OR it would have replaced something already filled in. Say
            // both, so a checked-but-not-applied row doesn't read as a bug.
            Text("These weren't applied for you — either the AI wasn't sure enough, or the field already had a value. Checked ones will be added when you apply.")
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
        // US-2267: pre-tick the opt-in rows that are safe to accept — medium
        // confidence or better, and the column is still unset. Raising the WRITE
        // bar moved these rows out of the auto-applied set; leaving them all
        // unticked would have turned a good fill into a row-by-row chore. Mirrors
        // the web panel, which default-checks a suggestion for any empty field and
        // writes nothing until Apply.
        acceptedLow = Set(
            stored.lowConfidence
                .filter { entry in
                    entry.confidence >= AIExtractStore.defaultAcceptConfidenceThreshold
                        && AIItemFieldWriter.isUnset(currentValue(for: entry.field), field: entry.field)
                }
                .map(\.field)
        )
        keepMeasurements = stored.measurementsApplied
    }

    private func finish() {
        AIFillReviewStore.shared.clear(for: item.id)
        dismiss()
    }

    /// This item's CURRENT value for a server field name — live truth, so the
    /// pre-tick decision reflects any edit made since the extraction ran (rather
    /// than the snapshot taken when the review was built).
    private func currentValue(for field: String) -> String? {
        switch field {
        case "title":            return item.title
        case "brand":            return item.brand
        case "size":             return item.size
        case "color":            return item.color
        case "material":         return item.material
        case "style":            return item.style
        case "description":      return item.itemDescription
        case "condition_notes":  return item.conditionNotes
        case "garment_type":     return item.garmentType
        case "garment_category": return item.garmentCategory
        case "item_category":    return item.itemCategory
        default:                 return nil
        }
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

        // US-1217: `department` is a canonical eBay aspect stored in
        // `inventory_items.attributes`, NOT a column the sparse `FieldUpdate`
        // knows — so an opted-in department conflict would be silently dropped by
        // the column `write` below. Route it through `writeAttributes` instead so
        // the user's choice actually persists with provenance.
        let acceptedColumnEntries = acceptedLowEntries.filter { !AIAttributeConfirm.keys.contains($0.field) }
        let acceptedAttributeEntries = acceptedLowEntries.filter { AIAttributeConfirm.keys.contains($0.field) }

        // Authoritative ai_field_sources for everything still AI-attributed.
        var finalSources: [String: AIItemFieldWriter.SourceEntry] = [:]
        for field in review.applied where keptApplied.contains(field.field) {
            finalSources[field.field] = .init(source: field.source, confidence: field.confidence, accepted: true)
        }
        // Column-bound low-conf entries get their ai_field_sources here; the
        // attribute-bound ones (department) record provenance via writeAttributes.
        for entry in acceptedColumnEntries {
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
                    fields: acceptedColumnEntries.map { (field: $0.field, value: $0.value) },
                    measurements: nil,
                    sources: finalSources,
                    seedTitle: false
                )
            }
            // 2b) US-1217: persist opted-in attribute conflicts (department) onto
            //     inventory_items.attributes with provenance — these aren't columns.
            if !acceptedAttributeEntries.isEmpty {
                try await AIItemFieldWriter.writeAttributes(
                    itemId: item.id,
                    results: acceptedAttributeEntries.map {
                        AIAttributeConfirm.Result(
                            key: $0.field,
                            value: $0.value,
                            source: $0.source,
                            confidence: $0.confidence
                        )
                    }
                )
            }
        } catch {
            errorMessage = "Couldn't save: \(error.localizedDescription)"
            HapticFeedback.error()
            return
        }

        // US-1531: report acceptance + corrections to the enrichment log
        // (fire-and-forget; measurement only — never blocks the save).
        reportAcceptance(
            review,
            unkept: unkept,
            acceptedLowEntries: acceptedLowEntries
        )

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
        // US-1182: confirm visibly (and to VoiceOver) before tearing down.
        A11yAnnounce.announce("AI suggestions applied")
        withAnimation { didApply = true }
        try? await Task.sleep(nanoseconds: 700_000_000)
        finish()
    }

    /// US-1531: acceptance + correction capture. Kept fields report their AI
    /// value as accepted; an UNDONE applied field is a correction signal — the
    /// user rejected the AI value in favor of what the column held before —
    /// reported as {suggested: AI value, final: restored value}. Matches the
    /// web recordAiAcceptance contract on PATCH /api/flipdesk/ai/log/:id.
    /// Fire-and-forget: measurement telemetry must never block or fail a save.
    private func reportAcceptance(
        _ review: AIFillReview,
        unkept: [AppliedAIField],
        acceptedLowEntries: [FieldSuggestionEntry]
    ) {
        guard let logId = review.logId, !logId.isEmpty else { return }

        struct CorrectedPair: Encodable {
            let suggested: String
            let finalValue: String

            enum CodingKeys: String, CodingKey {
                case suggested
                case finalValue = "final"
            }
        }
        struct Payload: Encodable {
            let accepted_fields: [String: String]
            let corrected_fields: [String: CorrectedPair]?
        }
        struct OkResponse: Decodable {
            let ok: Bool?
        }

        var accepted: [String: String] = [:]
        for field in review.applied where keptApplied.contains(field.field) {
            accepted[field.field] = field.value
        }
        for entry in acceptedLowEntries {
            accepted[entry.field] = entry.value
        }
        var corrected: [String: CorrectedPair] = [:]
        for field in unkept {
            corrected[field.field] = CorrectedPair(
                suggested: field.value,
                finalValue: field.previousValue ?? ""
            )
        }
        guard !accepted.isEmpty || !corrected.isEmpty else { return }

        let payload = Payload(
            accepted_fields: accepted,
            corrected_fields: corrected.isEmpty ? nil : corrected
        )
        Task {
            _ = try? await EdgeAPI.shared.patchJSON(
                "/api/flipdesk/ai/log/\(logId)",
                body: payload
            ) as OkResponse
        }
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
        modelContext.saveOrLog("commitLocal")
        HapticFeedback.success()
        NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
    }

    // MARK: - Helpers

    private func toggle(_ set: inout Set<String>, _ key: String) {
        if set.contains(key) { set.remove(key) } else { set.insert(key) }
    }
}
