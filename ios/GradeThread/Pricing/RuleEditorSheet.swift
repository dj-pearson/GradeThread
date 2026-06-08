import SwiftUI

/// Create or edit a repricing automation rule (US-672): scope (brand / category
/// / min age, or a single item), the markdown action (drop % every N days, with
/// a floor), and an optional auto-accept of high-confidence comp suggestions.
struct RuleEditorSheet: View {
    let existing: RepricingRule?
    let store: RepricingRulesStore

    @Environment(\.dismiss) private var dismiss
    @State private var draft: RuleDraft
    @State private var isSaving = false

    init(existing: RepricingRule?, store: RepricingRulesStore) {
        self.existing = existing
        self.store = store
        _draft = State(initialValue: existing.map(RuleDraft.init(from:)) ?? RuleDraft())
    }

    private var canSave: Bool { draft.isValid && !isSaving }
    private var isItemScoped: Bool { draft.inventoryItemId != nil }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Rule name", text: $draft.name)
                    Toggle("Enabled", isOn: $draft.enabled)
                } footer: {
                    Text("Disabled rules are skipped by the scheduler and Run now.")
                }

                scopeSection
                actionSection
                autoAcceptSection
            }
            .navigationTitle(existing == nil ? "New rule" : "Edit rule")
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

    @ViewBuilder
    private var scopeSection: some View {
        Section {
            if isItemScoped {
                LabeledContent("Scope", value: "A single item")
            } else {
                TextField("Brand (optional)", text: $draft.filterBrand)
                    .autocorrectionDisabled()
                TextField("eBay category id (optional)", text: $draft.filterCategoryId)
                    .keyboardType(.numberPad)
                Stepper(value: $draft.minAgeDays, in: 0...365, step: 1) {
                    Text("Only listings older than \(draft.minAgeDays) day\(draft.minAgeDays == 1 ? "" : "s")")
                }
            }
        } header: {
            Text("Scope")
        } footer: {
            Text(isItemScoped
                ? "This rule applies to one item."
                : "Leave blank to apply to every active eBay listing. Filters narrow it.")
        }
    }

    private var actionSection: some View {
        Section {
            Stepper(value: $draft.dropPct, in: 0...90, step: 1) {
                Text("Drop \(RepricingRule.trimPct(draft.dropPct))% each time")
            }
            Stepper(value: $draft.intervalDays, in: 1...90, step: 1) {
                Text("No more than every \(draft.intervalDays) day\(draft.intervalDays == 1 ? "" : "s")")
            }
            HStack {
                Text("Floor price")
                Spacer()
                Text("$").foregroundStyle(.secondary)
                TextField("none", text: $draft.floorPrice)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: 90)
            }
        } header: {
            Text("Markdown")
        } footer: {
            Text("Automation only ever lowers prices, never below the floor. A 0% drop relies on auto-accept below.")
        }
    }

    private var autoAcceptSection: some View {
        Section {
            Toggle("Auto-accept comp suggestions", isOn: $draft.autoAcceptEnabled)
            if draft.autoAcceptEnabled {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Minimum confidence: \(Int((draft.autoAcceptConfidence * 100).rounded()))%")
                        .font(.subheadline)
                    Slider(value: $draft.autoAcceptConfidence, in: 0.5...1, step: 0.05)
                        .tint(Color.brandNavy)
                }
            }
        } footer: {
            Text("When on, a pending comp suggestion at or above this confidence is applied instead of the flat drop — but only when it lowers the price.")
        }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        let ok = await store.save(draft, editingId: existing?.id)
        if ok { dismiss() }
    }
}
