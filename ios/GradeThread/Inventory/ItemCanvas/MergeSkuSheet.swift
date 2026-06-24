import SwiftUI

/// Shown when saving an item with a SKU that another inventory record already
/// owns (the `idx_inventory_items_user_sku` unique index). Lets the user
/// combine the two records into one: photos, listings, sales and grading
/// history are re-pointed server-side by the `merge_inventory_items` RPC, and
/// conflicting user-editable fields are resolved here — defaulting to the item
/// being edited (assumed most up to date). iOS mirror of the web
/// `MergeSkuDialog` (`src/components/flipdesk/merge-sku-dialog.tsx`).
struct MergeSkuSheet: View {
    /// Navigation title.
    var headerTitle: String = "Merge duplicate SKU"
    /// Plain-language description of what merging does (differs between the
    /// edit-canvas merge and the intake "combine into existing" flow).
    let explanation: String
    /// Column headings for the two sources being reconciled.
    var currentHeading: String = "This item"
    var existingHeading: String = "Existing record"
    /// Confirm-button label.
    var confirmLabel: String = "Merge"
    let conflicts: [ItemMergeConflict]
    /// True while the merge work is in flight.
    let merging: Bool
    /// Surfaced inline when the merge fails (the sheet stays open to retry).
    let errorMessage: String?
    /// Fields the user chose to take from the EXISTING record.
    let onConfirm: (Set<ItemMergeField>) -> Void
    let onCancel: () -> Void

    private enum Side { case current, existing }

    @State private var choices: [ItemMergeField: Side] = [:]

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(explanation)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if conflicts.isEmpty {
                    Section {
                        Text("No conflicting fields — the records can be merged as-is.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    ForEach(conflicts) { conflict in
                        Section {
                            choiceRow(
                                conflict: conflict,
                                side: .current,
                                heading: currentHeading,
                                value: conflict.currentDisplay
                            )
                            choiceRow(
                                conflict: conflict,
                                side: .existing,
                                heading: existingHeading,
                                value: conflict.existingDisplay
                            )
                        } header: {
                            HStack(spacing: 6) {
                                Text(conflict.label)
                                if !conflict.bothFilled {
                                    Text("(only on the existing record)")
                                        .textCase(.none)
                                        .foregroundStyle(.tertiary)
                                }
                            }
                        }
                    }
                }

                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(headerTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel).disabled(merging)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if merging {
                        // US-1188: label the spinner so a slow merge_inventory_items
                        // RPC doesn't leave the user staring at a bare wheel.
                        HStack(spacing: 6) {
                            ProgressView()
                            Text("Merging…").font(.footnote).foregroundStyle(.secondary)
                        }
                    } else {
                        Button(confirmLabel) {
                            let chosen = Set(
                                conflicts
                                    .filter { choices[$0.field] == .existing }
                                    .map(\.field)
                            )
                            onConfirm(chosen)
                        }
                        .fontWeight(.semibold)
                    }
                }
            }
            .interactiveDismissDisabled(merging)
        }
        .onAppear(perform: seedDefaults)
    }

    @ViewBuilder
    private func choiceRow(
        conflict: ItemMergeConflict,
        side: Side,
        heading: String,
        value: String
    ) -> some View {
        let selected = (choices[conflict.field] ?? .current) == side
        Button {
            choices[conflict.field] = side
        } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(selected ? Color.brandNavy : Color.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(heading)
                        .font(.caption2.weight(.medium))
                        .textCase(.uppercase)
                        .foregroundStyle(.secondary)
                    Text(value)
                        .font(.subheadline)
                        .foregroundStyle(value == "(empty)" ? .secondary : .primary)
                        .italic(value == "(empty)")
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(merging)
    }

    /// Real conflicts default to this item; gap-fills default to the existing
    /// record (mirrors the web dialog and `ItemMergePlan.defaultKeepExisting`).
    private func seedDefaults() {
        guard choices.isEmpty else { return }
        let keepExisting = ItemMergePlan.defaultKeepExisting(conflicts)
        var next: [ItemMergeField: Side] = [:]
        for conflict in conflicts {
            next[conflict.field] = keepExisting.contains(conflict.field) ? .existing : .current
        }
        choices = next
    }
}
