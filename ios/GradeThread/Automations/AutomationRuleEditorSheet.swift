import SwiftUI

/// Create or edit a general automation rule (US-1135): a trigger (days listed /
/// no views / few watchers), an action (price drop % / promo rate % / end
/// listing), and a scope (all active listings, or a filtered subset).
struct AutomationRuleEditorSheet: View {
    let existing: AutomationRule?
    let store: AutomationsStore

    @Environment(\.dismiss) private var dismiss
    @State private var draft: AutomationDraft
    @State private var isSaving = false

    init(existing: AutomationRule?, store: AutomationsStore) {
        self.existing = existing
        self.store = store
        _draft = State(initialValue: existing.map(AutomationDraft.init(from:)) ?? AutomationDraft())
    }

    private var canSave: Bool { draft.isValid && !isSaving }
    private var needsPct: Bool { draft.actionType != "end_listing" }
    private var maxPct: Double { draft.actionType == "price_drop_pct" ? 90 : 100 }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Rule name", text: $draft.name)
                    Toggle("Active", isOn: $draft.isActive)
                } footer: {
                    Text("Inactive rules are skipped by the scheduler and Run now.")
                }

                triggerSection
                actionSection
                scopeSection
            }
            .keyboardDoneToolbar()
            .scrollDismissesKeyboard(.interactively)
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

    // MARK: - When

    private var triggerSection: some View {
        Section {
            Picker("When", selection: $draft.triggerType) {
                ForEach(AutomationVocabulary.triggerTypes, id: \.value) { t in
                    Text(t.label).tag(t.value)
                }
            }
            if draft.triggerType == "watchers_lt_after_days" {
                Stepper(value: $draft.triggerWatchers, in: 1...100, step: 1) {
                    Text("Fewer than \(draft.triggerWatchers) watcher\(draft.triggerWatchers == 1 ? "" : "s")")
                }
            }
            Stepper(value: $draft.triggerDays, in: 1...365, step: 1) {
                Text("After \(draft.triggerDays) day\(draft.triggerDays == 1 ? "" : "s")")
            }
            Stepper(value: $draft.cooldownDays, in: 1...365, step: 1) {
                Text("Re-apply at most every \(draft.cooldownDays) day\(draft.cooldownDays == 1 ? "" : "s")")
            }
        } header: {
            Text("When")
        } footer: {
            Text("The cooldown limits how often the rule can touch the same listing.")
        }
    }

    // MARK: - Then

    private var actionSection: some View {
        Section {
            Picker("Then", selection: $draft.actionType) {
                ForEach(AutomationVocabulary.actionTypes, id: \.value) { a in
                    Text(a.label).tag(a.value)
                }
            }
            if needsPct {
                Stepper(value: $draft.actionPct, in: 1...maxPct, step: 1) {
                    Text("\(draft.actionType == "set_promo_rate_pct" ? "Promo rate" : "Drop") \(AutomationFormat.pct(draft.actionPct))%")
                }
            }
            if draft.actionType == "price_drop_pct" {
                Stepper(value: $draft.marginFloorPct, in: 0...500, step: 1) {
                    Text("Never below cost + \(draft.marginFloorPct)% margin")
                }
            }
        } header: {
            Text("Then")
        } footer: {
            if draft.actionType == "price_drop_pct" {
                Text("Automation only ever lowers prices, never below the margin floor.")
            } else if draft.actionType == "set_promo_rate_pct" {
                Text("Tracked in FlipDesk for now — not yet pushed to eBay Promoted Listings.")
            } else {
                Text("Ends the eBay listing and returns the item to drafts so you can relist.")
            }
        }
    }

    // MARK: - Scope

    private var scopeSection: some View {
        Section {
            Picker("Applies to", selection: $draft.scopeMode) {
                Text("All active listings").tag("all")
                Text("Filtered listings").tag("filter")
            }
            if draft.scopeMode == "filter" {
                Picker("Match", selection: $draft.combinator) {
                    Text("All filters (and)").tag("and")
                    Text("Any filter (or)").tag("or")
                }
                ForEach($draft.scopeRules) { $rule in
                    ScopeRuleEditor(rule: $rule)
                }
                .onDelete { draft.scopeRules.remove(atOffsets: $0) }
                Button {
                    draft.scopeRules.append(ScopeRuleDraft())
                } label: {
                    Label("Add filter", systemImage: "plus.circle")
                }
            }
        } header: {
            Text("Applies to")
        } footer: {
            Text(draft.scopeMode == "filter"
                ? "Rules with no value (other than “is empty”/“is set”) are ignored. No filters falls back to all listings."
                : "The rule evaluates every active eBay listing.")
        }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        let ok = await store.save(draft, editingId: existing?.id)
        if ok { dismiss() }
    }
}

/// One editable scope clause: field · operator · value.
private struct ScopeRuleEditor: View {
    @Binding var rule: ScopeRuleDraft

    private var valueless: Bool { rule.op == "isnull" || rule.op == "notnull" }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Picker("Field", selection: $rule.field) {
                    ForEach(AutomationVocabulary.scopeFields, id: \.value) { f in
                        Text(f.label).tag(f.value)
                    }
                }
                .labelsHidden()
                Picker("Operator", selection: $rule.op) {
                    ForEach(AutomationVocabulary.scopeOps, id: \.value) { o in
                        Text(o.label).tag(o.value)
                    }
                }
                .labelsHidden()
            }
            if !valueless {
                TextField("Value", text: $rule.value)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
            }
        }
        .padding(.vertical, 2)
    }
}
