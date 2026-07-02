import SwiftUI

/// eBay Category + Item Specifics editor. Search/select a leaf category, then
/// fill its aspects (required → recommended → optional) manually or with AI, and
/// save to the item. Saving updates `inventory_items.ebay_category_id` +
/// `ebay_aspects`, which the existing validate/publish flow already consumes.
struct EbayCategorySpecificsView: View {
    @State private var model: SpecificsEditorModel
    @State private var searchDebounce: Task<Void, Never>?
    /// US-1190: transient "no new suggestions" note after an empty AI fill.
    @State private var aiFillEmptyNote = false
    /// US-1513: Back tapped with unsaved specifics — confirm before losing them.
    @State private var showingDiscardConfirmation = false
    @Environment(\.dismiss) private var dismiss

    init(itemId: String, liveListingId: String? = nil) {
        _model = State(
            initialValue: SpecificsEditorModel(itemId: itemId, liveListingId: liveListingId)
        )
    }

    var body: some View {
        @Bindable var model = model
        Form {
            categorySection(model)

            if model.hasCategory {
                switch model.phase {
                case .loadingAspects:
                    Section { HStack { ProgressView(); Text("Loading item specifics…") } }
                case .failed(let message):
                    // US-1407: a failed aspect-spec load is RECOVERABLE — give an
                    // in-place retry instead of a dead-end label the user can only
                    // escape by backing out and reopening the sheet.
                    Section {
                        Label(message, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(Color.brandRed)
                        Button {
                            Task { await model.reload() }
                        } label: {
                            Label("Try again", systemImage: "arrow.clockwise")
                        }
                        .accessibilityHint("Reloads the eBay item specifics for this category")
                    }
                default:
                    aspectsContent(model)
                }
            }
        }
        .navigationTitle("eBay Specifics")
        .navigationBarTitleDisplayMode(.inline)
        // US-1513: this is a PUSHED view whose edits persist only via Save — a
        // back-tap or edge-swipe after "Fill with AI" + reviewing 10 aspects used
        // to silently lose everything. While dirty: hide the system chevron,
        // block the pop gesture, and route Back through a discard confirmation.
        .navigationBarBackButtonHidden(model.isDirty)
        .background(InteractivePopGuard(blocked: model.isDirty))
        .toolbar {
            if model.isDirty {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Back") { showingDiscardConfirmation = true }
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    Task { await saveAndDismiss() }
                }
                .disabled(!model.canSave)
            }
        }
        .confirmationDialog(
            "You have unsaved specifics",
            isPresented: $showingDiscardConfirmation,
            titleVisibility: .visible
        ) {
            if model.canSave {
                Button("Save & close") {
                    Task { await saveAndDismiss() }
                }
            }
            Button("Discard changes", role: .destructive) { dismiss() }
            Button("Keep editing", role: .cancel) {}
        } message: {
            Text("Going back without saving loses your edits — including anything Fill with AI added.")
        }
        .task {
            Telemetry.event("ebay_specifics_opened")
            await model.start()
        }
        // US-1190: surface save/search/AI-fill failures (model.errorMessage was
        // set but never rendered, leaving the sheet looking frozen).
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: { model.errorMessage != nil },
                set: { if !$0 { model.errorMessage = nil } }
            )
        ) {
            Button("OK") { model.errorMessage = nil }
        } message: {
            Text(model.errorMessage ?? "")
        }
        // US-824: confirm before discarding specifics that don't carry over to
        // a newly chosen category — never drop the seller's work silently.
        .alert(
            "Change category?",
            isPresented: Binding(
                get: { model.pendingCategoryChange != nil },
                set: { if !$0 { model.cancelCategoryChange() } }
            ),
            presenting: model.pendingCategoryChange
        ) { _ in
            Button("Keep current", role: .cancel) { model.cancelCategoryChange() }
            Button("Change & remove", role: .destructive) {
                Task { await model.confirmCategoryChange() }
            }
        } message: { pending in
            let names = pending.dropped.keys.sorted().joined(separator: ", ")
            Text(
                "\(pending.dropped.count) specific\(pending.dropped.count == 1 ? "" : "s") "
                + "won't carry over and will be removed: \(names). "
                + "Still-valid values are kept and gaps are refilled from this item — no AI is used."
            )
        }
    }

    /// Shared by the toolbar Save and the discard-confirm's "Save & close": a
    /// successful save dismisses; a failure keeps the editor open (the model's
    /// errorMessage alert explains).
    private func saveAndDismiss() async {
        if await model.save() {
            HapticFeedback.success()
            Telemetry.event("ebay_specifics_saved", props: [
                "category": model.selectedCategoryId ?? "",
                "aspects": model.values.count,
                "missing": model.missing.count,
            ])
            dismiss()
        } else {
            HapticFeedback.error()
        }
    }

    // MARK: - Category

    @ViewBuilder
    private func categorySection(_ model: SpecificsEditorModel) -> some View {
        @Bindable var model = model
        Section("eBay category") {
            // Prefer the full breadcrumb path ("Clothing › … › Jeans"), then the
            // leaf name, and only fall back to the raw id when neither resolved —
            // never surface "Category 11554" when a human-readable name exists.
            if let current = model.selectedCategoryPath
                ?? model.selectedCategoryName
                ?? model.selectedCategoryId
            {
                Label(current, systemImage: "tag.fill")
                    .foregroundStyle(Color.brandNavy)
            }
            TextField("Search categories…", text: $model.categoryQuery)
                .autocorrectionDisabled()
                .onChange(of: model.categoryQuery) { _, q in
                    searchDebounce?.cancel()
                    searchDebounce = Task { @MainActor in
                        try? await Task.sleep(nanoseconds: 300_000_000)
                        if !Task.isCancelled, q == model.categoryQuery { await model.search() }
                    }
                }
            if model.isSearching {
                HStack { ProgressView(); Text("Searching…").foregroundStyle(.secondary) }
            }
            ForEach(model.suggestions, id: \.categoryId) { suggestion in
                Button {
                    Task { await model.select(suggestion) }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(suggestion.categoryName).foregroundStyle(.primary)
                        if !suggestion.categoryTreePath.isEmpty {
                            Text(suggestion.categoryTreePath)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Aspects

    @ViewBuilder
    private func aspectsContent(_ model: SpecificsEditorModel) -> some View {
        if model.specs.isEmpty {
            Section {
                Text("This category has no item specifics.")
                    .foregroundStyle(.secondary)
            }
        } else {
            // US-825: pre-publish checklist — list the required-but-unfilled
            // aspects at the very top so the seller sees exactly what's missing
            // BEFORE saving/publishing, not as a publish-time failure.
            if !model.missing.isEmpty {
                Section {
                    Label(
                        "\(model.missing.count) required specific\(model.missing.count == 1 ? "" : "s") still missing",
                        systemImage: "exclamationmark.triangle.fill"
                    )
                    .foregroundStyle(Color.brandRed)
                    ForEach(model.missing, id: \.self) { name in
                        Text(name)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } footer: {
                    Text("eBay won't publish until these are filled. Use AI fill or enter them below.")
                }
            }
            Section {
                Button {
                    Task {
                        aiFillEmptyNote = false
                        let filled = await model.fillWithAI()
                        // US-1190: distinct feedback per outcome instead of an
                        // always-"light" haptic that looks identical on success,
                        // no-match, and error.
                        if model.errorMessage != nil {
                            HapticFeedback.error()   // alert handles the message
                        } else if filled == 0 {
                            aiFillEmptyNote = true
                            HapticFeedback.warning()
                        } else {
                            HapticFeedback.success()
                        }
                        Telemetry.event("ebay_specifics_ai_fill", props: ["filled": filled])
                    }
                } label: {
                    if model.isFillingAI {
                        HStack { ProgressView(); Text("Filling with AI…") }
                    } else {
                        Label("Fill with AI", systemImage: "wand.and.stars")
                    }
                }
                .disabled(model.isFillingAI)
                .accessibilityHint("Suggests item-specific values from the item's details and photos.")
            } footer: {
                if aiFillEmptyNote {
                    Text("No new suggestions — enter the specifics below.")
                } else if !model.aiFilled.isEmpty {
                    Text("AI filled \(model.aiFilled.count) specific\(model.aiFilled.count == 1 ? "" : "s"). Review before saving.")
                }
            }

            aspectGroup(model, "Required", model.specs.filter { $0.usage == .required })
            aspectGroup(model, "Recommended", model.specs.filter { $0.usage == .recommended })
            aspectGroup(model, "Optional", model.specs.filter { $0.usage == .optional })
        }
    }

    @ViewBuilder
    private func aspectGroup(_ model: SpecificsEditorModel, _ title: String, _ specs: [AspectSpec]) -> some View {
        if !specs.isEmpty {
            Section(title) {
                ForEach(specs) { spec in
                    aspectRow(model, spec)
                }
            }
        }
    }

    @ViewBuilder
    private func aspectRow(_ model: SpecificsEditorModel, _ spec: AspectSpec) -> some View {
        if spec.selectionOnly, !spec.allowedValues.isEmpty {
            if spec.multiSelect {
                Menu {
                    ForEach(spec.allowedValues, id: \.self) { value in
                        Button {
                            model.toggleMulti(value, for: spec.name)
                        } label: {
                            Label(value, systemImage: model.isSelected(value, for: spec.name) ? "checkmark" : "")
                        }
                    }
                } label: {
                    LabeledContent {
                        Text(multiSummary(model, spec)).foregroundStyle(.secondary)
                    } label: {
                        aspectLabel(model, spec)
                    }
                }
            } else {
                Picker(
                    selection: Binding(
                        get: { model.firstValue(for: spec.name) },
                        set: { model.setSingle($0, for: spec.name) }
                    )
                ) {
                    Text("—").tag("")
                    ForEach(spec.allowedValues, id: \.self) { Text($0).tag($0) }
                } label: {
                    aspectLabel(model, spec)
                }
            }
        } else {
            LabeledContent {
                TextField(
                    "Value",
                    text: Binding(
                        get: { model.firstValue(for: spec.name) },
                        set: { model.setSingle($0, for: spec.name) }
                    )
                )
                .multilineTextAlignment(.trailing)
                .autocorrectionDisabled()
            } label: {
                aspectLabel(model, spec)
            }
        }
    }

    /// US-825: aspect name + provenance badge (AI / Auto / You) when filled.
    @ViewBuilder
    private func aspectLabel(_ model: SpecificsEditorModel, _ spec: AspectSpec) -> some View {
        HStack(spacing: 6) {
            Text(spec.name)
            if let prov = model.provenance(for: spec.name) {
                Text(prov.badgeLabel)
                    // US-1411: a Dynamic-Type style (scales) rather than a fixed
                    // 9pt that's below the legible floor and never grows.
                    .font(.caption2.weight(.medium))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(badgeColor(prov).opacity(0.15), in: Capsule())
                    .foregroundStyle(badgeColor(prov))
                    .accessibilityLabel(prov.badgeHint)
            }
        }
    }

    private func badgeColor(_ prov: AspectProvenance) -> Color {
        switch prov {
        case .aiExtracted: return Color.brandRed
        case .inventoryDerived: return Color.brandNavy
        case .manual: return .secondary
        }
    }

    private func multiSummary(_ model: SpecificsEditorModel, _ spec: AspectSpec) -> String {
        let selected = model.values[spec.name]?.filter { !$0.isEmpty } ?? []
        return selected.isEmpty ? "Select" : selected.joined(separator: ", ")
    }
}
