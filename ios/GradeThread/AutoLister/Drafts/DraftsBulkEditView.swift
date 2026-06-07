import SwiftUI

/// AutoLister bulk-edit grid (US-675): edit a batch of generated drafts inline
/// (title / price / condition / category), multi-select, and bulk-apply price
/// markup, round-to-.99, condition, category, or a template (condition +
/// category + policies), then save. Mirrors the web autolister-bulk-edit page.
struct DraftsBulkEditView: View {
    @State private var store: DraftsBulkEditStore
    @State private var templateStore = TemplateStore()
    @State private var markupPct: String = ""
    @State private var bulkCategory: String = ""

    init(batchId: String? = nil) {
        _store = State(initialValue: DraftsBulkEditStore(batchId: batchId))
    }

    var body: some View {
        content
            .navigationTitle("Bulk edit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await store.save() }
                    } label: {
                        if store.isSaving {
                            ProgressView()
                        } else {
                            Text(store.dirtyCount > 0 ? "Save (\(store.dirtyCount))" : "Save")
                                .fontWeight(.semibold)
                        }
                    }
                    .disabled(store.isSaving || store.dirtyCount == 0)
                }
            }
            .task {
                await store.load()
                await templateStore.load()
            }
            .alert(
                "Couldn't save",
                isPresented: Binding(
                    get: { store.actionError != nil },
                    set: { if !$0 { store.actionError = nil } }
                ),
                presenting: store.actionError
            ) { _ in
                Button("OK", role: .cancel) { store.actionError = nil }
            } message: { Text($0) }
    }

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .loading:
            ScrollView { SkeletonRows(count: 6) }

        case .failed(let message):
            ContentUnavailableView {
                Label("Couldn't load drafts", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") { Task { await store.load() } }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.brandNavy)
            }

        case .ready where store.rows.isEmpty:
            ContentUnavailableView(
                "No drafts to edit",
                systemImage: "square.stack.3d.up",
                description: Text("Generate listings in AutoLister to bulk-edit them here.")
            )

        case .ready:
            grid
        }
    }

    private var grid: some View {
        List {
            bulkActionsSection
            Section {
                ForEach(store.rows) { row in
                    DraftEditRowView(store: store, rowId: row.id)
                }
            } header: {
                HStack {
                    Text("\(store.rows.count) draft\(store.rows.count == 1 ? "" : "s")")
                    Spacer()
                    Button(store.allSelected ? "Deselect all" : "Select all") {
                        store.toggleSelectAll()
                    }
                    .font(.caption.weight(.semibold))
                    .textCase(nil)
                }
            }
        }
    }

    // MARK: - Bulk actions

    private var bulkActionsSection: some View {
        Section {
            (Text("Applies to ") + Text(store.selectionSummary).bold())
                .font(.caption)
                .foregroundStyle(.secondary)

            // Price
            HStack {
                TextField("Markup %", text: $markupPct)
                    .keyboardType(.numbersAndPunctuation)
                    .textFieldStyle(.roundedBorder)
                Button("Apply") { store.applyMarkup(markupPct) }
                    .buttonStyle(.bordered)
                    .disabled(Double(markupPct.trimmingCharacters(in: .whitespaces)) == nil)
                Button("Round .99") { store.applyRound99() }
                    .buttonStyle(.bordered)
            }

            // Condition
            Menu {
                ForEach(EbayCondition.allCases) { c in
                    Button(c.label) { store.applyCondition(c.rawValue) }
                }
            } label: {
                Label("Set condition", systemImage: "tag")
            }

            // Category
            HStack {
                TextField("eBay category id", text: $bulkCategory)
                    .keyboardType(.numberPad)
                    .textFieldStyle(.roundedBorder)
                Button("Apply") { store.applyCategory(bulkCategory) }
                    .buttonStyle(.bordered)
                    .disabled(bulkCategory.trimmingCharacters(in: .whitespaces).isEmpty)
            }

            // Template (condition + category + policies)
            if !templateStore.templates.isEmpty {
                Menu {
                    ForEach(templateStore.templates) { t in
                        Button(t.name) { store.applyTemplate(t) }
                    }
                } label: {
                    Label("Apply template", systemImage: "doc.on.doc")
                }
            }
        } header: {
            Text("Bulk actions")
        } footer: {
            Text("Bulk actions apply to your selection, or to every row when nothing is selected. Templates set condition, category, and shipping/return/payment policies.")
        }
    }
}

// MARK: - Editable row

/// One editable draft row. Reads its row from the store by id so observation
/// re-renders it on bulk applies; field bindings route through `store.update`
/// so every edit marks the row dirty (mirrors the web's patchRow).
private struct DraftEditRowView: View {
    let store: DraftsBulkEditStore
    let rowId: String

    private var row: DraftEditRow? { store.rows.first { $0.id == rowId } }

    var body: some View {
        if let row {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top, spacing: 10) {
                    Button {
                        store.toggle(rowId)
                    } label: {
                        Image(systemName: store.selected.contains(rowId) ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(store.selected.contains(rowId) ? Color.brandNavy : .secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(store.selected.contains(rowId) ? "Selected" : "Not selected")

                    VStack(alignment: .leading, spacing: 6) {
                        TextField(store.titleFallback(for: row), text: stringBinding(\.title))
                            .textFieldStyle(.roundedBorder)
                            .font(.subheadline)
                        HStack(spacing: 8) {
                            HStack(spacing: 2) {
                                Text("$").foregroundStyle(.secondary)
                                TextField("0.00", text: stringBinding(\.price))
                                    .keyboardType(.decimalPad)
                                    .frame(maxWidth: 80)
                            }
                            .padding(.horizontal, 8).padding(.vertical, 6)
                            .background(Color(uiColor: .tertiarySystemFill))
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

                            conditionMenu(current: row.condition)

                            Spacer()
                            if !row.issues.isEmpty {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .font(.caption)
                                    .foregroundStyle(Color.brandAmber)
                                    .accessibilityLabel("Issues: \(row.issues.joined(separator: ", "))")
                            }
                        }
                        HStack(spacing: 6) {
                            Image(systemName: "square.grid.2x2").font(.caption2).foregroundStyle(.secondary)
                            TextField("category id", text: stringBinding(\.categoryId))
                                .keyboardType(.numberPad)
                                .font(.caption)
                        }
                    }
                }
            }
            .padding(.vertical, 2)
        }
    }

    private func conditionMenu(current: String) -> some View {
        Menu {
            ForEach(EbayCondition.allCases) { c in
                Button(c.label) { store.update(rowId) { $0.condition = c.rawValue } }
            }
            if !current.isEmpty {
                Button("Clear", role: .destructive) { store.update(rowId) { $0.condition = "" } }
            }
        } label: {
            Text(current.isEmpty ? "Condition" : EbayCondition.resolve(current).label)
                .font(.caption.weight(.medium))
                .lineLimit(1)
                .padding(.horizontal, 8).padding(.vertical, 6)
                .background(Color.brandNavy.opacity(0.1))
                .foregroundStyle(Color.brandNavy)
                .clipShape(Capsule())
        }
    }

    /// Binding for a String field that routes writes through `store.update`,
    /// marking the row dirty on every keystroke.
    private func stringBinding(_ keyPath: WritableKeyPath<DraftEditRow, String>) -> Binding<String> {
        Binding(
            get: { store.rows.first(where: { $0.id == rowId })?[keyPath: keyPath] ?? "" },
            set: { newValue in store.update(rowId) { $0[keyPath: keyPath] = newValue } }
        )
    }
}
