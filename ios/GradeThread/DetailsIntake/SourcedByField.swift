import SwiftData
import SwiftUI

/// The "Sourced by" control (US-2886): pick a person from the workspace roster
/// instead of typing a name, and add one without leaving the form.
///
/// Web parity with `src/components/flipdesk/sourced-by-select.tsx`. The value
/// written out is still the plain NAME, because that is what
/// `inventory_items.sourced_by` stores on every platform.
///
/// **Adding is INLINE, not a sheet, on purpose.** A view has one sheet slot, and
/// both callers (``DetailsIntakeView`` and `ItemCanvasView`) already spend
/// theirs — see `Scripts/check-chained-sheets.py`. Revealing a row inside the
/// same Form section costs nothing and cannot lose that race.
struct SourcedByField: View {
    @Binding var value: String

    /// The workspace owner whose roster this is. `nil` while signed out, which
    /// leaves the picker read-only rather than crashing.
    let userId: String?

    @Environment(\.modelContext) private var modelContext
    @Query(sort: \LocalSourcer.name) private var sourcers: [LocalSourcer]

    @State private var store: SourcerStore?
    @State private var isAdding = false
    @State private var draftName = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    /// Sentinel row. SwiftUI does not expose Picker row actions, so the "add"
    /// tap is detected in `onChange` and the selection is put back.
    private static let addSentinel = "__add_person__"

    /// An archived person stays visible while they are the current value, so
    /// editing an old item does not silently drop its attribution.
    private var visible: [LocalSourcer] {
        sourcers.filter { !$0.isArchived || $0.name == value }
    }

    /// A name typed before this field became a picker (or imported from a CSV)
    /// still has to be selectable, or opening an old item would blank it.
    private var offRoster: String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let lowered = trimmed.lowercased()
        return sourcers.contains { $0.name.lowercased() == lowered } ? nil : trimmed
    }

    var body: some View {
        Group {
            Picker("Sourced by", selection: $value) {
                Text("Not set").tag("")
                if let offRoster {
                    Text(offRoster).tag(offRoster)
                }
                ForEach(visible, id: \.id) { person in
                    Text(person.name).tag(person.name)
                }
                Text("Add person…").tag(Self.addSentinel)
            }
            .onChange(of: value) { oldValue, newValue in
                guard newValue == Self.addSentinel else { return }
                value = oldValue == Self.addSentinel ? "" : oldValue
                errorMessage = nil
                isAdding = true
            }

            if isAdding {
                HStack {
                    TextField("Name", text: $draftName)
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                        .disabled(isSaving)
                        .onSubmit { Task { await commit() } }
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Add") { Task { await commit() } }
                            .buttonStyle(.borderless)
                            .disabled(draftName.trimmingCharacters(in: .whitespaces).isEmpty)
                        Button("Cancel") { cancel() }
                            .buttonStyle(.borderless)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
        .task {
            if store == nil {
                store = SourcerStore(container: modelContext.container)
            }
            if let userId {
                await store?.refresh(userId: userId)
            }
        }
    }

    private func cancel() {
        draftName = ""
        errorMessage = nil
        isAdding = false
    }

    private func commit() async {
        let name = draftName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            cancel()
            return
        }
        guard let store, let userId else {
            errorMessage = "Sign in to add someone to the roster."
            return
        }
        isSaving = true
        defer { isSaving = false }
        do {
            value = try await store.addSourcer(userId: userId, name: name)
            draftName = ""
            errorMessage = nil
            isAdding = false
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
