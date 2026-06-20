import SwiftData
import SwiftUI

/// Settings → Data → Sources (US-814). The iOS parity surface for the web
/// `/dashboard/flipdesk/sources` CRUD: list every acquisition source with its
/// item count + total acquisition spend, create / edit / archive, and tap a
/// source to open the inventory filtered to it.
///
/// Reads sources + items from the SwiftData cache via `@Query` (the source rows
/// are backfilled by ``SourceStore/refresh(userId:)``, which uses the RLS-scoped
/// user JWT client). All writes route through ``SourceStore`` and are scoped to
/// the signed-in user.
struct SourcesView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(AuthStore.self) private var authStore

    @Query(sort: \LocalSource.name) private var sources: [LocalSource]
    /// Item rows feed the per-source count + acquisition-spend rollup.
    @Query private var items: [LocalInventoryItem]

    @State private var store: SourceStore?
    @State private var editing: EditingTarget?
    @State private var isRefreshing = false
    @State private var actionError: String?

    private let currency = CurrencyFormatter()

    private var activeSources: [LocalSource] { sources.filter { !$0.isArchived } }
    private var archivedSources: [LocalSource] { sources.filter { $0.isArchived } }

    /// `sources.id` → (item count, total acquisition spend), derived from the
    /// local item cache so the numbers match the rest of the app exactly.
    private var statsBySource: [String: (count: Int, spend: Double)] {
        var out: [String: (count: Int, spend: Double)] = [:]
        for item in items {
            guard let sid = item.sourceId else { continue }
            var entry = out[sid] ?? (count: 0, spend: 0.0)
            entry.count += 1
            entry.spend += item.acquiredPrice ?? 0
            out[sid] = entry
        }
        return out
    }

    var body: some View {
        List {
            Section {
                Button {
                    editing = .new
                } label: {
                    Label("Add source", systemImage: "plus.circle")
                }
            } footer: {
                Text("Track where your inventory comes from. Archiving a source keeps its items and their history — it just hides the source from the intake picker.")
                    .font(.footnote)
            }

            if sources.isEmpty {
                Section {
                    if isRefreshing {
                        ProgressView().frame(maxWidth: .infinity)
                    } else {
                        ContentUnavailableView(
                            "No sources yet",
                            systemImage: "mappin.and.ellipse",
                            description: Text("Add a source to attribute ROI by where you sourced each item.")
                        )
                    }
                }
            } else {
                if !activeSources.isEmpty {
                    Section {
                        ForEach(activeSources) { source in
                            sourceRow(source)
                        }
                    } header: {
                        Text("\(activeSources.count) source\(activeSources.count == 1 ? "" : "s")")
                    }
                }

                if !archivedSources.isEmpty {
                    Section {
                        ForEach(archivedSources) { source in
                            sourceRow(source)
                        }
                    } header: {
                        Text("Archived")
                    } footer: {
                        Text("Archived sources stay linked to their existing items but no longer appear when cataloging new items.")
                            .font(.footnote)
                    }
                }
            }
        }
        .navigationTitle("Sources")
        .task {
            if store == nil {
                store = SourceStore(container: modelContext.container)
            }
            await refresh()
        }
        .refreshable { await refresh() }
        .sheet(item: $editing) { target in
            if let store, let userId = currentUserId() {
                SourceEditorSheet(store: store, userId: userId, target: target)
            }
        }
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: { actionError != nil },
                set: { if !$0 { actionError = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(actionError ?? "")
        }
    }

    @ViewBuilder
    private func sourceRow(_ source: LocalSource) -> some View {
        let stats = statsBySource[source.id]
        // Tapping the row opens the inventory pre-filtered to this source.
        NavigationLink {
            InventoryListView(initialSourceId: source.id)
                .navigationTitle(source.name)
                .navigationBarTitleDisplayMode(.inline)
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(source.name)
                    .font(.body)
                    .foregroundStyle(source.isArchived ? .secondary : .primary)
                HStack(spacing: 8) {
                    Text(sourceTypeLabel(source.sourceType))
                    Text("·")
                    Text("\(stats?.count ?? 0) item\((stats?.count ?? 0) == 1 ? "" : "s")")
                    if let spend = stats?.spend, spend > 0 {
                        Text("·")
                        Text("\(currency.formatDisplay(spend)) spent")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button {
                Task { await setArchived(source, archived: !source.isArchived) }
            } label: {
                source.isArchived
                    ? Label("Restore", systemImage: "tray.and.arrow.up")
                    : Label("Archive", systemImage: "archivebox")
            }
            .tint(source.isArchived ? Color.brandEmerald : Color.brandAmber)

            Button {
                editing = .existing(source)
            } label: {
                Label("Edit", systemImage: "pencil")
            }
            .tint(Color.brandNavy)
        }
        .contextMenu {
            Button {
                editing = .existing(source)
            } label: {
                Label("Edit", systemImage: "pencil")
            }
            Button {
                Task { await setArchived(source, archived: !source.isArchived) }
            } label: {
                source.isArchived
                    ? Label("Restore", systemImage: "tray.and.arrow.up")
                    : Label("Archive", systemImage: "archivebox")
            }
        }
    }

    private func sourceTypeLabel(_ raw: String) -> String {
        FlipdeskSourceType(rawValue: raw)?.label ?? "Other"
    }

    private func refresh() async {
        guard let store, let userId = currentUserId() else { return }
        isRefreshing = true
        await store.refresh(userId: userId)
        isRefreshing = false
        if let error = store.lastError {
            actionError = error.localizedDescription
            store.lastError = nil
        }
    }

    private func setArchived(_ source: LocalSource, archived: Bool) async {
        guard let store, let userId = currentUserId() else { return }
        do {
            try await store.setArchived(id: source.id, userId: userId, archived: archived)
            HapticFeedback.success()
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func currentUserId() -> String? {
        if case let .signedIn(user) = authStore.phase {
            return user.id.uuidString
        }
        return nil
    }

    enum EditingTarget: Identifiable {
        case new
        case existing(LocalSource)

        var id: String {
            switch self {
            case .new: return "new"
            case .existing(let s): return s.id
            }
        }
    }
}

/// Create / edit a source. Reuses ``SourceStore`` for the RLS-scoped insert /
/// update + local-cache merge.
struct SourceEditorSheet: View {
    @Environment(\.dismiss) private var dismiss

    let store: SourceStore
    let userId: String
    let target: SourcesView.EditingTarget

    @State private var name: String = ""
    @State private var type: FlipdeskSourceType = .thrift
    @State private var notes: String = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var editingId: String? {
        if case .existing(let s) = target { return s.id }
        return nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("Goodwill on Elm St", text: $name)
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                }

                Section("Type") {
                    Picker("Type", selection: $type) {
                        ForEach(FlipdeskSourceType.allCases) { type in
                            Text(type.label).tag(type)
                        }
                    }
                    .pickerStyle(.menu)
                }

                Section("Notes (optional)") {
                    TextField("Hours, contact, etc.", text: $notes, axis: .vertical)
                        .lineLimit(3, reservesSpace: false)
                }

                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                            .font(.footnote)
                    }
                }
            }
            .navigationTitle(editingId == nil ? "New source" : "Edit source")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await save() }
                    } label: {
                        if isSaving {
                            ProgressView()
                        } else {
                            Text("Save")
                        }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || isSaving)
                }
            }
            .onAppear {
                if case .existing(let s) = target {
                    name = s.name
                    type = FlipdeskSourceType(rawValue: s.sourceType) ?? .other
                    notes = s.notes ?? ""
                }
            }
        }
    }

    private func save() async {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedNotes = notes.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else { return }

        isSaving = true
        defer { isSaving = false }

        do {
            if let editingId {
                try await store.updateSource(
                    id: editingId,
                    userId: userId,
                    name: trimmedName,
                    type: type,
                    notes: trimmedNotes.isEmpty ? nil : trimmedNotes
                )
            } else {
                _ = try await store.addSource(
                    userId: userId,
                    name: trimmedName,
                    type: type,
                    notes: trimmedNotes.isEmpty ? nil : trimmedNotes
                )
            }
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
