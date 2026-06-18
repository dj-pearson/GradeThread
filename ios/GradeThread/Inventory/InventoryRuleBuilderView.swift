import SwiftUI

/// Advanced AND/OR rule builder (US-1052), pushed from the filter sheet. Edits
/// an ``InventoryRuleQuery`` in place: a top-level "Match All of / Any of"
/// combinator plus a list of field/op/value rules. Mirrors the web
/// `filter-builder.tsx` power tool so iOS reaches parity for resellers who need
/// "Nike OR Patagonia, target ≥ $40" style cross-field logic the canned facets
/// can't express.
struct InventoryRuleBuilderView: View {
    @Binding var query: InventoryRuleQuery

    var body: some View {
        Form {
            if query.rules.count > 1 {
                Section {
                    Picker("Match", selection: $query.combinator) {
                        ForEach(InventoryRuleQuery.Combinator.allCases) { c in
                            Text(c.label).tag(c)
                        }
                    }
                    .pickerStyle(.segmented)
                } footer: {
                    Text(query.combinator == .and
                         ? "Items must satisfy every rule below."
                         : "Items matching any rule below are included.")
                }
            }

            Section {
                ForEach(query.rules.indices, id: \.self) { idx in
                    ruleRow(at: idx)
                }
                .onDelete { query.rules.remove(atOffsets: $0) }

                Button {
                    AppRouter.haptic()
                    withAnimation { query.rules.append(InventoryRuleQuery.Rule()) }
                } label: {
                    Label("Add rule", systemImage: "plus.circle")
                }
            } header: {
                Text("Rules")
            } footer: {
                if query.rules.isEmpty {
                    Text("Build cross-field logic the facet pickers can't — e.g. brand is any of Nike, Patagonia.")
                }
            }
        }
        .navigationTitle("Advanced rules")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !query.rules.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Clear") {
                        AppRouter.haptic()
                        withAnimation { query = .empty }
                    }
                }
            }
        }
    }

    // MARK: - Rule row

    @ViewBuilder
    private func ruleRow(at idx: Int) -> some View {
        let rule = ruleBinding(idx)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                fieldMenu(rule)
                opMenu(rule)
                Spacer(minLength: 0)
            }
            if rule.wrappedValue.op.requiresValue {
                TextField(valuePrompt(for: rule.wrappedValue.field), text: rule.value)
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(rule.wrappedValue.field.isNumeric ? .decimalPad : .default)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
            }
        }
        .padding(.vertical, 4)
    }

    private func fieldMenu(_ rule: Binding<InventoryRuleQuery.Rule>) -> some View {
        Menu {
            ForEach(InventoryRuleQuery.Field.allCases) { field in
                Button(field.label) { setField(field, on: rule) }
            }
        } label: {
            pill(rule.wrappedValue.field.label, system: "chevron.up.chevron.down")
        }
    }

    private func opMenu(_ rule: Binding<InventoryRuleQuery.Rule>) -> some View {
        Menu {
            ForEach(availableOps(for: rule.wrappedValue.field)) { op in
                Button(op.label) { rule.wrappedValue.op = op }
            }
        } label: {
            pill(rule.wrappedValue.op.label, system: "chevron.up.chevron.down")
        }
    }

    private func pill(_ text: String, system: String) -> some View {
        HStack(spacing: 4) {
            Text(text).font(.subheadline.weight(.medium))
            Image(systemName: system).font(.caption2)
        }
        .foregroundStyle(Color.brandNavy)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color.brandNavy.opacity(0.10))
        .clipShape(Capsule())
    }

    // MARK: - Helpers

    /// Index-safe `Binding` into one rule. Built by hand rather than relying on
    /// a `Binding` array subscript, and guards the index so a mid-delete render
    /// can't trap.
    private func ruleBinding(_ idx: Int) -> Binding<InventoryRuleQuery.Rule> {
        Binding(
            get: { query.rules.indices.contains(idx) ? query.rules[idx] : InventoryRuleQuery.Rule() },
            set: { if query.rules.indices.contains(idx) { query.rules[idx] = $0 } }
        )
    }

    private func availableOps(for field: InventoryRuleQuery.Field) -> [InventoryRuleQuery.Op] {
        field.isNumeric ? InventoryRuleQuery.Op.numericOps : InventoryRuleQuery.Op.textOps
    }

    /// Switching a rule's field can invalidate its operator (text↔numeric have
    /// different op sets); snap the op back to a valid one for the new field.
    private func setField(_ field: InventoryRuleQuery.Field, on rule: Binding<InventoryRuleQuery.Rule>) {
        rule.wrappedValue.field = field
        let ops = availableOps(for: field)
        if !ops.contains(rule.wrappedValue.op) {
            rule.wrappedValue.op = ops.first ?? .eq
        }
    }

    private func valuePrompt(for field: InventoryRuleQuery.Field) -> String {
        switch field.isNumeric {
        case true:  return "Number"
        case false: return field.label
        }
    }
}
