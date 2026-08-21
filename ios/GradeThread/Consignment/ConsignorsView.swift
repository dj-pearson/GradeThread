import SwiftUI

/// Settings → Data → Consignors (US-676). Lists consignors with CRUD and a
/// route to the per-consignor payout report.
struct ConsignorsView: View {
    @State private var store = ConsignorStore()
    /// One optional driving ONE `.sheet(item:)`. A view has a single sheet
    /// slot, so two `.sheet` modifiers on it compete for that slot and the
    /// loser presents and is torn down in the same frame — see ``ToolModule``
    /// and `Scripts/check-chained-sheets.py`.
    @State private var sheet: ConsignorSheet?

    /// The sheets this screen presents.
    enum ConsignorSheet: Identifiable {
        /// Create a consignor, or edit an existing one.
        case editor(EditingTarget)
        /// The payout/consignment report across every consignor.
        case report

        var id: String {
            switch self {
            case .editor(let target): return "editor-\(target.id)"
            case .report:             return "report"
            }
        }
    }

    var body: some View {
        List {
            Section {
                Button {
                    sheet = .editor(.new)
                } label: {
                    Label("Add consignor", systemImage: "plus.circle")
                }
                Button {
                    sheet = .report
                } label: {
                    Label("Payout report", systemImage: "chart.bar.doc.horizontal")
                }
            }

            switch store.phase {
            case .loading:
                // US-1200: shared skeleton instead of a bare spinner.
                Section { SkeletonRows(count: 4) }
            case .failed(let message):
                // US-1200: the shared error state has an in-place retry — the
                // ContentUnavailableView here had none, a dead end.
                Section {
                    ErrorStateView(
                        title: "Couldn't load consignors",
                        message: message,
                        retry: { await store.load() }
                    )
                }
            case .ready:
                if store.isEmpty {
                    Section {
                        ContentUnavailableView(
                            "No consignors yet",
                            systemImage: "person.2",
                            description: Text("Add a consignor to track items you sell on their behalf and what you owe them.")
                        )
                    }
                } else {
                    Section {
                        ForEach(store.consignors) { consignor in
                            Button {
                                sheet = .editor(.existing(consignor))
                            } label: {
                                consignorRow(consignor)
                            }
                            .tint(.primary)
                        }
                    } header: {
                        Text("\(store.consignors.count) consignor\(store.consignors.count == 1 ? "" : "s")")
                    }
                }
            }
        }
        .navigationTitle("Consignors")
        .task { await store.load() }
        // US-1026: manual pull-to-refresh. `load()` guards against a reload
        // that lands while one is already in flight, so the gesture can't kick
        // off a duplicate concurrent fetch.
        .refreshable { await store.load() }
        .sheet(item: $sheet) { presented in
            switch presented {
            case .editor(let target):
                ConsignorEditorSheet(store: store, target: target)
            case .report:
                NavigationStack {
                    ConsignmentReportView(store: store)
                }
            }
        }
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: { store.actionError != nil },
                set: { if !$0 { store.actionError = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.actionError ?? "")
        }
    }

    @ViewBuilder
    private func consignorRow(_ consignor: Consignor) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(consignor.name).font(.body)
            HStack(spacing: 8) {
                Text("\(Int(consignor.defaultSplitPct))% split")
                if let email = consignor.contactEmail, !email.isEmpty {
                    Text("·")
                    Text(email)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    enum EditingTarget: Identifiable {
        case new
        case existing(Consignor)
        var id: String {
            switch self {
            case .new: return "new"
            case .existing(let c): return c.id
            }
        }
    }
}

/// Create / edit a consignor.
struct ConsignorEditorSheet: View {
    let store: ConsignorStore
    let target: ConsignorsView.EditingTarget

    @Environment(\.dismiss) private var dismiss
    @State private var draft = ConsignorDraft()
    @State private var isSaving = false
    @State private var showDeleteConfirm = false

    private var editingId: String? {
        if case .existing(let c) = target { return c.id }
        return nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Consignor") {
                    TextField("Name", text: $draft.name)
                        .textInputAutocapitalization(.words)
                    TextField("Email (optional)", text: $draft.contactEmail)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Phone (optional)", text: $draft.contactPhone)
                        .keyboardType(.phonePad)
                }
                Section {
                    VStack(alignment: .leading) {
                        Text("Consignor's split: \(Int(draft.defaultSplitPct))%")
                        Slider(value: $draft.defaultSplitPct, in: 0...100, step: 5)
                            // US-1223: the slider read as an unlabeled value-less
                            // control — name it and speak the percent split.
                            .accessibilityLabel("Consignor's split")
                            .accessibilityValue("\(Int(draft.defaultSplitPct)) percent")
                    }
                } header: {
                    Text("Default split")
                } footer: {
                    Text("The consignor's share of net proceeds (sale price minus fees) when an item has no per-item override. You keep \(Int(100 - draft.defaultSplitPct))%.")
                }
                Section("Notes") {
                    TextField("Notes (optional)", text: $draft.notes, axis: .vertical)
                        .lineLimit(2...5)
                }

                if case .existing(let consignor) = target {
                    Section {
                        Button(role: .destructive) {
                            showDeleteConfirm = true
                        } label: {
                            Label("Delete consignor", systemImage: "trash")
                        }
                        .confirmationDialog(
                            "Delete consignor?",
                            isPresented: $showDeleteConfirm,
                            titleVisibility: .visible
                        ) {
                            Button("Delete consignor", role: .destructive) {
                                Task {
                                    await store.delete(consignor)
                                    dismiss()
                                }
                            }
                            Button("Cancel", role: .cancel) {}
                        } message: {
                            Text("This removes \(consignor.name). Linked items keep their sale history but lose the consignor link.")
                        }
                    } footer: {
                        Text("Items currently linked to this consignor keep their sale history; they just lose the consignor link.")
                    }
                }
            }
            .navigationTitle(editingId == nil ? "New Consignor" : "Edit Consignor")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    // US-1223: surface the in-flight save with a spinner instead
                    // of a silently-disabled button.
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Save") {
                            Task {
                                isSaving = true
                                let ok = await store.save(draft, editingId: editingId)
                                isSaving = false
                                if ok { dismiss() }
                            }
                        }
                        .disabled(!draft.isValid)
                    }
                }
            }
            .onAppear {
                if case .existing(let c) = target { draft = ConsignorDraft(c) }
            }
        }
    }
}
