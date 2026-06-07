import SwiftUI

/// Create or edit a listing template (US-674). Captures the full preset: name,
/// default flag, description boilerplate, condition + note, eBay category,
/// business policies, and item-specifics defaults. Saves through ``TemplateStore``.
struct TemplateEditorSheet: View {
    let existing: ListingTemplate?
    let store: TemplateStore

    @Environment(\.dismiss) private var dismiss

    @State private var draft: TemplateDraft
    @State private var specifics: [SpecificPair]
    /// nil = "No default" (the template won't set a condition).
    @State private var conditionSelection: EbayCondition?
    @State private var isSaving = false

    init(existing: ListingTemplate?, store: TemplateStore) {
        self.existing = existing
        self.store = store
        let d = existing.map(TemplateDraft.init(from:)) ?? TemplateDraft()
        _draft = State(initialValue: d)
        _specifics = State(
            initialValue: d.itemSpecifics
                .map { SpecificPair(name: $0.key, value: $0.value) }
                .sorted { $0.name.lowercased() < $1.name.lowercased() }
        )
        _conditionSelection = State(
            initialValue: d.ebayCondition.isEmpty ? nil : EbayCondition(rawValue: d.ebayCondition)
        )
    }

    private var canSave: Bool { draft.isValid && !isSaving }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Template name", text: $draft.name)
                    Toggle("Default template", isOn: $draft.isDefault)
                } footer: {
                    Text("The default template is pre-selected when you publish or run AutoLister.")
                }

                Section {
                    TextField(
                        "e.g. Ships next business day. Smoke-free home. Bundle to save.",
                        text: $draft.descriptionTemplate,
                        axis: .vertical
                    )
                    .lineLimit(3...8)
                } header: {
                    Text("Description boilerplate")
                } footer: {
                    Text("Appended after the listing's main description — never replaces it.")
                }

                Section("Condition") {
                    Picker("Default condition", selection: $conditionSelection) {
                        Text("No default").tag(EbayCondition?.none)
                        ForEach(EbayCondition.allCases) { c in
                            Text(c.label).tag(EbayCondition?.some(c))
                        }
                    }
                    TextField("Condition note (optional)", text: $draft.conditionDescription, axis: .vertical)
                        .lineLimit(1...3)
                }

                Section {
                    TextField("eBay category ID", text: $draft.ebayCategoryId)
                        .keyboardType(.numberPad)
                } header: {
                    Text("Category")
                } footer: {
                    Text("Optional. The numeric eBay category id to default new listings to.")
                }

                Section {
                    TextField("Shipping policy ID", text: $draft.shippingPolicyId)
                    TextField("Return policy ID", text: $draft.returnPolicyId)
                    TextField("Payment policy ID", text: $draft.paymentPolicyId)
                } header: {
                    Text("Business policies")
                } footer: {
                    Text("Optional eBay business-policy IDs applied to AutoLister drafts.")
                }

                specificsSection
            }
            .navigationTitle(existing == nil ? "New template" : "Edit template")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .fontWeight(.semibold)
                        .disabled(!canSave)
                }
            }
        }
    }

    private var specificsSection: some View {
        Section {
            ForEach($specifics) { $pair in
                HStack(spacing: 8) {
                    TextField("Name", text: $pair.name)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Divider()
                    TextField("Value", text: $pair.value)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .onDelete { specifics.remove(atOffsets: $0) }

            Button {
                specifics.append(SpecificPair(name: "", value: ""))
            } label: {
                Label("Add specific", systemImage: "plus")
            }
        } header: {
            Text("Item specifics defaults")
        } footer: {
            Text("Pre-fill recurring item specifics (e.g. Department · Men, Type · T-Shirt).")
        }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        draft.ebayCondition = conditionSelection?.rawValue ?? ""
        draft.itemSpecifics = Self.collapse(specifics)
        let ok = await store.save(draft, editingId: existing?.id)
        if ok { dismiss() }
    }

    /// Fold the ordered editor rows into a `{name: value}` map, trimming and
    /// dropping rows with a blank name (last write wins on duplicate names).
    static func collapse(_ pairs: [SpecificPair]) -> [String: String] {
        var out: [String: String] = [:]
        for pair in pairs {
            let name = pair.name.trimmingCharacters(in: .whitespacesAndNewlines)
            let value = pair.value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty, !value.isEmpty else { continue }
            out[name] = value
        }
        return out
    }
}

/// One editable item-specific row. Identity is stable across edits so SwiftUI
/// keeps focus while typing.
struct SpecificPair: Identifiable, Equatable {
    let id = UUID()
    var name: String
    var value: String
}
