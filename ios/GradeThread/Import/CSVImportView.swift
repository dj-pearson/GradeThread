import SwiftUI
import UniformTypeIdentifiers

/// US-667 — guided CSV / Google Sheets inventory import. Three steps: choose a
/// source, map columns to fields with a live preview, then commit. Reached from
/// Settings. Imported rows go through the same server-confirmed insert path as
/// manual intake (SKU-dedup aware), with per-row errors surfaced at the end.
struct CSVImportView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AuthStore.self) private var authStore
    @State private var store = ImportStore()

    @State private var sheetURL = ""
    @State private var showingFileImporter = false

    private var userId: String? {
        if case let .signedIn(user) = authStore.phase { return user.id.uuidString }
        return nil
    }

    var body: some View {
        NavigationStack {
            Group {
                switch store.phase {
                case .source:     sourceStep
                case .mapping:    mappingStep
                case .committing: committingStep
                case .done:       doneStep
                }
            }
            .navigationTitle("Import inventory")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close") { dismiss() }
                }
                if store.phase == .mapping {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Back") { store.reset() }
                    }
                }
            }
            .fileImporter(
                isPresented: $showingFileImporter,
                allowedContentTypes: [.commaSeparatedText, .tabSeparatedText, .plainText, .text],
                allowsMultipleSelection: false
            ) { handleFileImport($0) }
            .alert("Import problem", isPresented: Binding(
                get: { store.errorBanner != nil },
                set: { if !$0 { store.errorBanner = nil } }
            )) {
                Button("OK", role: .cancel) { store.errorBanner = nil }
            } message: {
                Text(store.errorBanner ?? "")
            }
        }
    }

    // MARK: - Step 1: source

    private var sourceStep: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Bring your existing catalog in from a spreadsheet. Your first row should be column headers.")
                    .font(.subheadline).foregroundStyle(.secondary)

                VStack(alignment: .leading, spacing: 12) {
                    Label("From a CSV file", systemImage: "doc.text")
                        .font(.subheadline.weight(.semibold))
                    Button("Choose file…") { showingFileImporter = true }
                        .buttonStyle(.brandSecondary)
                }
                .padding(16)
                .cardStyle(.flush)

                VStack(alignment: .leading, spacing: 12) {
                    Label("From Google Sheets", systemImage: "tablecells")
                        .font(.subheadline.weight(.semibold))
                    Text("Share the sheet as \"Anyone with the link\" (Viewer), then paste its URL.")
                        .font(.caption).foregroundStyle(.secondary)
                    TextField("https://docs.google.com/spreadsheets/…", text: $sheetURL)
                        .textFieldStyle(.roundedBorder)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    Button {
                        Task { await store.loadFromSheet(url: sheetURL) }
                    } label: {
                        if store.isFetching { ProgressView() } else { Text("Fetch sheet") }
                    }
                    .buttonStyle(.brandPrimary)
                    .disabled(sheetURL.isEmpty || store.isFetching)
                }
                .padding(16)
                .cardStyle(.flush)
            }
            .padding(16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }

    // MARK: - Step 2: mapping + preview

    private var mappingStep: some View {
        VStack(spacing: 0) {
            List {
                Section {
                    ForEach(Array((store.sheet?.headers ?? []).enumerated()), id: \.offset) { index, header in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(header.isEmpty ? "Column \(index + 1)" : header)
                                    .font(.subheadline.weight(.medium))
                                if let sample = sampleValue(column: index) {
                                    Text(sample).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }
                            }
                            Spacer()
                            Picker("", selection: bindingForColumn(index)) {
                                ForEach(ImportField.allCases) { field in
                                    Text(field.label).tag(field)
                                }
                            }
                            .labelsHidden()
                        }
                    }
                } header: {
                    Text("Map your columns")
                } footer: {
                    if !store.hasTitleMapping {
                        Text("Map one column to \"Item title\" — it's required.")
                            .foregroundStyle(Color.brandRed)
                    } else {
                        Text("\(store.readyCount) ready · \(store.errorCount) skipped")
                    }
                }
            }

            commitBar
        }
    }

    private var commitBar: some View {
        VStack(spacing: 8) {
            Button {
                guard let userId else {
                    store.errorBanner = "Your session expired. Sign in again to import."
                    return
                }
                Task { await store.commit(userId: userId) }
            } label: {
                Text(store.readyCount > 0 ? "Import \(store.readyCount) item\(store.readyCount == 1 ? "" : "s")" : "Nothing to import")
            }
            .buttonStyle(.brandPrimary)
            .disabled(!store.canCommit)
        }
        .padding(16)
        .background(.bar)
    }

    // MARK: - Step 3: committing

    private var committingStep: some View {
        VStack(spacing: 16) {
            ProgressView(value: Double(store.progressDone), total: Double(max(store.progressTotal, 1)))
                .padding(.horizontal, 40)
            Text("Importing \(store.progressDone) of \(store.progressTotal)…")
                .font(.subheadline).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Step 4: done

    private var doneStep: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let result = store.result {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("\(result.inserted) imported", systemImage: "checkmark.seal.fill")
                            .foregroundStyle(Color.brandEmerald)
                        if result.skippedDuplicates > 0 {
                            Label("\(result.skippedDuplicates) skipped (duplicate SKU)", systemImage: "doc.on.doc")
                                .foregroundStyle(.secondary)
                        }
                        if !result.errors.isEmpty {
                            Label("\(result.errors.count) failed", systemImage: "exclamationmark.triangle")
                                .foregroundStyle(Color.brandRed)
                        }
                    }
                    .font(.subheadline)
                    .padding(16)
                    .cardStyle(.flush)

                    if !result.errors.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Rows that didn't import").font(.subheadline.weight(.semibold))
                            ForEach(result.errors, id: \.row) { err in
                                Text("Row \(err.row): \(err.message)")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                        .cardStyle(.flush)
                    }
                }
                Button("Done") { dismiss() }
                    .buttonStyle(.brandPrimary)
            }
            .padding(16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }

    // MARK: - Helpers

    private func bindingForColumn(_ index: Int) -> Binding<ImportField> {
        Binding(
            get: { index < store.mapping.count ? store.mapping[index] : .skip },
            set: { if index < store.mapping.count { store.mapping[index] = $0 } }
        )
    }

    private func sampleValue(column: Int) -> String? {
        guard let first = store.sheet?.rows.first, column < first.count else { return nil }
        let v = first[column].trimmingCharacters(in: .whitespaces)
        return v.isEmpty ? nil : v
    }

    private func handleFileImport(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            guard let url = urls.first else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            do {
                let text = try String(contentsOf: url, encoding: .utf8)
                store.loadCSV(text)
            } catch {
                // Fall back to a lenient encoding for sheets exported as Latin-1.
                if let data = try? Data(contentsOf: url),
                   let text = String(data: data, encoding: .isoLatin1) {
                    store.loadCSV(text)
                } else {
                    store.errorBanner = "Couldn't read that file: \(error.localizedDescription)"
                }
            }
        case .failure(let error):
            store.errorBanner = error.localizedDescription
        }
    }
}
