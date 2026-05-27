import SwiftUI

/// Modal form for creating a new source. Surfaces from the intake-form's
/// source picker when the user picks "Add new source…". On successful
/// save, returns the new source id via `onAdded` so the calling picker
/// can auto-select it.
struct AddSourceSheet: View {
    @Environment(\.dismiss) private var dismiss

    /// Shared store — performs the actual Supabase insert + cache merge.
    let store: SourceStore
    let userId: String
    let onAdded: (String) -> Void

    @State private var name: String = ""
    @State private var type: FlipdeskSourceType = .thrift
    @State private var notes: String = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

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
            .navigationTitle("New source")
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
        }
    }

    private func save() async {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedNotes = notes.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else { return }

        isSaving = true
        defer { isSaving = false }

        do {
            let newId = try await store.addSource(
                userId: userId,
                name: trimmedName,
                type: type,
                notes: trimmedNotes.isEmpty ? nil : trimmedNotes
            )
            onAdded(newId)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
