import SwiftUI

/// eBay Category + Item Specifics editor. Search/select a leaf category, then
/// fill its aspects (required → recommended → optional) manually or with AI, and
/// save to the item. Saving updates `inventory_items.ebay_category_id` +
/// `ebay_aspects`, which the existing validate/publish flow already consumes.
struct EbayCategorySpecificsView: View {
    @State private var model: SpecificsEditorModel
    @State private var searchDebounce: Task<Void, Never>?
    @Environment(\.dismiss) private var dismiss

    init(itemId: String) {
        _model = State(initialValue: SpecificsEditorModel(itemId: itemId))
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
                    Section {
                        Label(message, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(Color.brandRed)
                    }
                default:
                    aspectsContent(model)
                }
            }
        }
        .navigationTitle("eBay Specifics")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    Task {
                        HapticFeedback.medium()
                        if await model.save() { dismiss() }
                    }
                }
                .disabled(!model.canSave)
            }
        }
        .task { await model.start() }
    }

    // MARK: - Category

    @ViewBuilder
    private func categorySection(_ model: SpecificsEditorModel) -> some View {
        @Bindable var model = model
        Section("eBay category") {
            if let current = model.selectedCategoryName ?? model.selectedCategoryId {
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
            if !model.missing.isEmpty {
                Section {
                    Label(
                        "\(model.missing.count) required field\(model.missing.count == 1 ? "" : "s") still needed",
                        systemImage: "exclamationmark.triangle.fill"
                    )
                    .foregroundStyle(Color.brandRed)
                }
            }
            Section {
                Button {
                    Task { await model.fillWithAI() }
                } label: {
                    if model.isFillingAI {
                        HStack { ProgressView(); Text("Filling with AI…") }
                    } else {
                        Label("Fill with AI", systemImage: "wand.and.stars")
                    }
                }
                .disabled(model.isFillingAI)
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
                    LabeledContent(spec.name) {
                        Text(multiSummary(model, spec)).foregroundStyle(.secondary)
                    }
                }
            } else {
                Picker(
                    spec.name,
                    selection: Binding(
                        get: { model.firstValue(for: spec.name) },
                        set: { model.setSingle($0, for: spec.name) }
                    )
                ) {
                    Text("—").tag("")
                    ForEach(spec.allowedValues, id: \.self) { Text($0).tag($0) }
                }
            }
        } else {
            LabeledContent(spec.name) {
                TextField(
                    "Value",
                    text: Binding(
                        get: { model.firstValue(for: spec.name) },
                        set: { model.setSingle($0, for: spec.name) }
                    )
                )
                .multilineTextAlignment(.trailing)
                .autocorrectionDisabled()
            }
        }
    }

    private func multiSummary(_ model: SpecificsEditorModel, _ spec: AspectSpec) -> String {
        let selected = model.values[spec.name]?.filter { !$0.isEmpty } ?? []
        return selected.isEmpty ? "Select" : selected.joined(separator: ", ")
    }
}
