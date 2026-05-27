import SwiftData
import SwiftUI

/// Manual intake form. Reachable from the Add tab → "Details-first
/// (manual form)" sheet. Mirrors the web `src/pages/flipdesk/intake.tsx`
/// field set in a SwiftUI Form. Saves to inventory_items via
/// supabase-swift; falls through to a LocalPendingMutation when offline
/// so a thrift trip with patchy signal still lets the user catalog.
struct DetailsIntakeView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Environment(AuthStore.self) private var authStore

    @Query(sort: \LocalSource.name) private var sources: [LocalSource]

    @State private var form = IntakeFormState()
    @State private var sourceStore: SourceStore?
    @State private var showingAddSourceSheet = false
    @State private var isSaving = false
    @State private var bannerMessage: BannerMessage?
    private let currencyFormatter = CurrencyFormatter()

    // Voice + barcode shortcuts (US-179)
    @State private var dictation = SpeechDictation()
    @State private var notesAnchorBeforeDictation: String = ""
    @State private var showingBarcodeScanner = false

    /// Bottom toast — surfaced both for online success and the offline
    /// fallback. Auto-clears after a beat so the screen returns to a
    /// neutral state for the next "Add another" iteration.
    private struct BannerMessage: Identifiable, Equatable {
        let id = UUID()
        let kind: Kind
        let text: String

        enum Kind { case success, offline, failure }
    }

    var body: some View {
        Form {
            itemSection
            sourcingSection
            notesSection
            actionSection
            if let banner = bannerMessage {
                bannerSection(banner)
            }
        }
        .navigationTitle("New item")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Close") { dismiss() }.disabled(isSaving)
            }
        }
        .task {
            // Construct the store lazily so it inherits the live
            // ModelContainer from the environment, not the placeholder
            // one a struct-level @State default would freeze in.
            if sourceStore == nil {
                sourceStore = SourceStore(container: modelContext.container)
            }
            if let userId = currentUserId() {
                await sourceStore?.refresh(userId: userId)
            }
        }
        .sheet(isPresented: $showingAddSourceSheet) {
            if let store = sourceStore, let userId = currentUserId() {
                AddSourceSheet(store: store, userId: userId) { newId in
                    form.sourceId = newId
                }
            }
        }
        .fullScreenCover(isPresented: $showingBarcodeScanner) {
            BarcodeScanView { code in
                form.sku = code
            }
        }
        .onDisappear {
            // Don't leave the audio engine running if the user swipes the
            // intake away mid-dictation.
            if dictation.isRecording { dictation.stop() }
        }
        // Live-stream recognized text into the bound notes field. We
        // append to the snapshot we took when dictation started rather
        // than replacing the whole notes value — so if the user already
        // had typed text, dictation extends it instead of overwriting.
        .onChange(of: dictation.recognizedText) { _, newText in
            guard dictation.isRecording else { return }
            if notesAnchorBeforeDictation.isEmpty {
                form.notes = newText
            } else {
                let separator = notesAnchorBeforeDictation.hasSuffix(" ") ? "" : " "
                form.notes = notesAnchorBeforeDictation + separator + newText
            }
        }
    }

    // MARK: - Dictation control

    private func toggleDictation() async {
        if dictation.isRecording {
            dictation.stop()
            return
        }
        notesAnchorBeforeDictation = form.notes
        AppRouter.haptic()
        await dictation.start()
    }

    // MARK: - Sections

    private var itemSection: some View {
        Section("Item") {
            TextField("Title", text: $form.title)
                .textInputAutocapitalization(.words)

            HStack {
                TextField("SKU", text: $form.sku)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button {
                    AppRouter.haptic()
                    showingBarcodeScanner = true
                } label: {
                    Image(systemName: "barcode.viewfinder")
                        .font(.system(size: 20))
                        .foregroundStyle(Color.brandNavy)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Scan barcode for SKU")
            }

            TextField("Brand", text: $form.brand)
                .textInputAutocapitalization(.words)

            TextField("Style", text: $form.style)
                .textInputAutocapitalization(.sentences)

            TextField("Size", text: $form.size)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

            TextField("Color", text: $form.color)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

            TextField("Material", text: $form.material)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

            Picker("Category", selection: $form.category) {
                ForEach(FlipdeskCategory.allCases) { c in
                    Text(c.label).tag(c)
                }
            }

            Picker("Status", selection: $form.status) {
                ForEach(IntakeStatus.allCases) { s in
                    Text(s.label).tag(s)
                }
            }
        }
    }

    private var sourcingSection: some View {
        Section("Sourcing") {
            sourcePicker

            TextField("Container", text: $form.container)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()

            TextField("Sourced by", text: $form.sourcedBy)
                .textInputAutocapitalization(.words)

            DatePicker(
                "Purchase date",
                selection: $form.purchaseDate,
                displayedComponents: .date
            )

            HStack {
                Text(currencyFormatter.symbol)
                    .foregroundStyle(.secondary)
                TextField("Purchase price", text: $form.purchasePriceText)
                    .keyboardType(.decimalPad)
            }
        }
    }

    private var sourcePicker: some View {
        Picker("Source", selection: $form.sourceId) {
            Text("None").tag(String?.none)
            ForEach(sources, id: \.id) { source in
                Text(source.name).tag(Optional(source.id))
            }
            // Sentinel value so we can detect the "Add new" tap without
            // a separate button. SwiftUI doesn't expose Picker row
            // actions, so we drive the sheet via onChange below.
            Text("Add new source…").tag(Optional("__add_new__"))
        }
        .onChange(of: form.sourceId) { _, newValue in
            if newValue == "__add_new__" {
                form.sourceId = nil
                showingAddSourceSheet = true
            }
        }
    }

    private var notesSection: some View {
        Section {
            // autoFocus disabled — the user almost never opens this
            // screen wanting to start with the notes field, and the
            // keyboard popping unexpectedly was a frequent web-side
            // friction point that we don't repeat here.
            HStack(alignment: .top) {
                TextField("Notes", text: $form.notes, axis: .vertical)
                    .lineLimit(3...6)
                if dictation.isAvailable {
                    Button {
                        Task { await toggleDictation() }
                    } label: {
                        Image(systemName: dictation.isRecording
                              ? "stop.circle.fill"
                              : "mic.fill")
                            .font(.system(size: 22))
                            .foregroundStyle(dictation.isRecording ? Color.brandRed : Color.brandNavy)
                            .symbolEffect(.pulse, isActive: dictation.isRecording)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(dictation.isRecording ? "Stop dictation" : "Start dictation")
                }
            }
        } header: {
            Text("Notes")
        } footer: {
            if let error = dictation.lastError {
                Text(error.localizedDescription)
                    .font(.footnote)
                    .foregroundStyle(.red)
            } else if dictation.isRecording {
                Text("Listening — tap the mic to stop.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var actionSection: some View {
        Section {
            Button {
                Task { await save(then: .dismiss) }
            } label: {
                primaryButtonLabel(title: "Save")
            }
            .frame(maxWidth: .infinity)
            .disabled(!form.canSubmit || isSaving)

            Button {
                Task { await save(then: .addAnother) }
            } label: {
                secondaryButtonLabel(title: "Save & Add another")
            }
            .frame(maxWidth: .infinity)
            .disabled(!form.canSubmit || isSaving)
        }
    }

    private func bannerSection(_ banner: BannerMessage) -> some View {
        Section {
            Label(banner.text, systemImage: bannerIcon(for: banner.kind))
                .font(.footnote)
                .foregroundStyle(bannerColor(for: banner.kind))
        }
    }

    // MARK: - Button labels

    private func primaryButtonLabel(title: String) -> some View {
        HStack(spacing: 6) {
            if isSaving { ProgressView().tint(.white) }
            Text(title).font(.subheadline.weight(.semibold))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(Color.brandNavy)
        .foregroundStyle(.white)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func secondaryButtonLabel(title: String) -> some View {
        Text(title)
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(Color(uiColor: .secondarySystemBackground))
            .foregroundStyle(Color.brandNavy)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func bannerIcon(for kind: BannerMessage.Kind) -> String {
        switch kind {
        case .success: return "checkmark.circle.fill"
        case .offline: return "wifi.slash"
        case .failure: return "exclamationmark.triangle.fill"
        }
    }

    private func bannerColor(for kind: BannerMessage.Kind) -> Color {
        switch kind {
        case .success: return .green
        case .offline: return .orange
        case .failure: return .red
        }
    }

    // MARK: - Save flow

    private enum SaveOutcome { case dismiss, addAnother }

    private func save(then outcome: SaveOutcome) async {
        guard let userId = currentUserId() else {
            bannerMessage = BannerMessage(kind: .failure, text: "Sign in expired. Sign in again to save.")
            return
        }
        guard form.canSubmit, !isSaving else { return }

        isSaving = true
        defer { isSaving = false }

        let payload = buildInsertPayload(userId: userId)
        do {
            try await SupabaseShared.client
                .from("inventory_items")
                .insert(payload)
                .execute()
            handleSavedSuccessfully(outcome: outcome)
        } catch {
            // If the failure looks network-y, queue the mutation locally
            // so the SyncEngine can replay it on reconnect. Anything
            // else (RLS denial, enum mismatch, etc.) is a real
            // configuration problem and surfaces to the user as-is.
            if isNetworkFailure(error) {
                enqueueOfflineMutation(payload: payload)
                handleSavedOffline(outcome: outcome)
            } else {
                bannerMessage = BannerMessage(
                    kind: .failure,
                    text: "Couldn't save: \(error.localizedDescription)"
                )
            }
        }
    }

    private func handleSavedSuccessfully(outcome: SaveOutcome) {
        bannerMessage = BannerMessage(kind: .success, text: "Saved.")
        switch outcome {
        case .dismiss:
            dismiss()
        case .addAnother:
            form.resetForBatchAddAnother()
            AppRouter.haptic()
        }
    }

    private func handleSavedOffline(outcome: SaveOutcome) {
        bannerMessage = BannerMessage(
            kind: .offline,
            text: "Saved offline — will sync when you reconnect."
        )
        switch outcome {
        case .dismiss:
            dismiss()
        case .addAnother:
            form.resetForBatchAddAnother()
            AppRouter.haptic()
        }
    }

    private func isNetworkFailure(_ error: Error) -> Bool {
        let nsError = error as NSError
        // URLError domain → network connectivity issue (offline, DNS,
        // TLS, timeout). Anything else → application-level rejection
        // we shouldn't silently queue.
        if nsError.domain == NSURLErrorDomain { return true }
        // supabase-swift surfaces some network errors via its own
        // domain; do a string match as a defensive net.
        let lower = error.localizedDescription.lowercased()
        return lower.contains("offline")
            || lower.contains("network")
            || lower.contains("timed out")
    }

    private func enqueueOfflineMutation(payload: ItemInsertPayload) {
        guard let data = try? JSONEncoder().encode(payload) else { return }
        let mutation = LocalPendingMutation(
            kind: .createInventoryItem,
            payload: data,
            targetId: nil
        )
        modelContext.insert(mutation)
        try? modelContext.save()
    }

    private func buildInsertPayload(userId: String) -> ItemInsertPayload {
        let trimmedTitle = form.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return ItemInsertPayload(
            user_id: userId,
            title: trimmedTitle,
            sku: form.sku.nonEmpty,
            brand: form.brand.nonEmpty,
            style: form.style.nonEmpty,
            size: form.size.nonEmpty,
            color: form.color.nonEmpty,
            material: form.material.nonEmpty,
            item_category: form.category.rawValue,
            status: form.status.rawValue,
            source_id: form.sourceId,
            container: form.container.nonEmpty,
            sourced_by: form.sourcedBy.nonEmpty,
            acquired_date: ISO8601DateFormatter()
                .string(from: form.purchaseDate)
                .components(separatedBy: "T").first,
            acquired_price: currencyFormatter.parse(form.purchasePriceText),
            description: form.notes.nonEmpty
        )
    }

    private func currentUserId() -> String? {
        if case let .signedIn(user) = authStore.phase {
            return user.id.uuidString
        }
        return nil
    }
}

// MARK: - Wire payload

/// Encodable subset of `inventory_items` the form writes. Nullable fields
/// stay nil and get skipped by the encoder so we don't overwrite defaults.
struct ItemInsertPayload: Codable {
    let user_id: String
    let title: String
    let sku: String?
    let brand: String?
    let style: String?
    let size: String?
    let color: String?
    let material: String?
    let item_category: String?
    let status: String
    let source_id: String?
    let container: String?
    let sourced_by: String?
    /// ISO date string (YYYY-MM-DD). `inventory_items.acquired_date` is
    /// stored as a Postgres date, no time component.
    let acquired_date: String?
    let acquired_price: Double?
    let description: String?
}

private extension String {
    /// Trim + nilify empty strings so the insert doesn't write an empty
    /// string where Postgres expects NULL. Postgres treats those
    /// differently — empty strings would block the column's IS NULL
    /// filters downstream.
    var nonEmpty: String? {
        let trimmed = self.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
