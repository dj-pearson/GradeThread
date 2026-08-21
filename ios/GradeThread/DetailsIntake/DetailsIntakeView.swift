import SwiftData
import SwiftUI
import UIKit

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

    /// US-651: explicit field order so the keyboard 'Next' key walks the form
    /// top-to-bottom instead of dismissing after each field.
    private enum Field: Hashable {
        case title, sku, brand, style, size, color, material, container, sourcedBy, purchasePrice
    }
    @FocusState private var focusedField: Field?
    /// One optional driving ONE `.sheet(item:)`. A view has a single sheet
    /// slot, so two `.sheet` modifiers on it compete for that slot and the
    /// loser presents and is torn down in the same frame — see ``ToolModule``
    /// and `Scripts/check-chained-sheets.py`.
    @State private var sheet: IntakeSheet?

    /// The duplicate-SKU combine-into-existing sheet. A function rather than
    /// an inline case body so the `let sku` binding stays in ordinary Swift
    /// rather than inside a result builder.
    @ViewBuilder
    private func skuMergeSheet(_ existing: ExistingSkuItem) -> some View {
        let sku = form.sku.trimmingCharacters(in: .whitespacesAndNewlines)
        MergeSkuSheet(
            headerTitle: "SKU already in use",
            explanation: "An item with SKU “\(sku)” already exists. Combine your new details into it instead of creating a duplicate? Pick which value to keep where they differ — your new entry is selected by default. Nothing is duplicated; the existing item is updated.",
            currentHeading: "Your entry",
            existingHeading: "Existing item",
            confirmLabel: "Combine",
            conflicts: skuMergeConflicts,
            merging: isMergingSku,
            errorMessage: skuMergeError,
            onConfirm: { chosen in
                Task { await confirmIntakeMerge(existing: existing, keepExisting: chosen) }
            },
            onCancel: {
                guard !isMergingSku else { return }
                sheet = nil
                skuMergeError = nil
            }
        )
    }

    /// The sheets the details-first intake form presents.
    private enum IntakeSheet: Identifiable {
        /// Add a new source without leaving the form.
        case addSource
        /// Duplicate-SKU combine-into-existing (intake variant of the merge).
        case skuMerge(ExistingSkuItem)

        var id: String {
            switch self {
            case .addSource:              return "addSource"
            case .skuMerge(let existing): return "skuMerge-\(existing.id)"
            }
        }
    }
    @State private var isSaving = false
    @State private var bannerMessage: BannerMessage?
    /// US-646: a recoverable draft from a prior (background-killed) session.
    @State private var pendingDraft: IntakeDraftStore.Draft?
    private let currencyFormatter = CurrencyFormatter()

    /// Drives the resume alert off `pendingDraft`.
    private var showingDraftResumeBinding: Binding<Bool> {
        Binding(get: { pendingDraft != nil }, set: { if !$0 { pendingDraft = nil } })
    }

    /// Concatenation of every form field — `.onChange` on this triggers an
    /// autosave whenever anything the user can edit changes.
    private var draftSignature: String {
        [form.title, form.sku, form.brand, form.style, form.size, form.color,
         form.material, form.category.rawValue, form.status.rawValue,
         form.sourceId ?? "", form.container, form.sourcedBy,
         form.purchasePriceText, form.notes,
         ISO8601DateFormatter().string(from: form.purchaseDate)].joined(separator: "\u{1F}")
    }

    // Voice + barcode shortcuts (US-179)
    @State private var dictation = SpeechDictation()
    @State private var notesAnchorBeforeDictation: String = ""
    @State private var showingBarcodeScanner = false

    // Duplicate-SKU "combine into existing" (web parity, intake variant): when
    // the entered SKU already belongs to an item we pre-check BEFORE inserting
    // and offer to combine the new details into that item instead of creating a
    // duplicate (which would trip idx_inventory_items_user_sku).
    @State private var skuMergeConflicts: [ItemMergeConflict] = []
    @State private var isMergingSku = false
    @State private var skuMergeError: String?
    @State private var pendingMergeOutcome: SaveOutcome = .dismiss

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
        .keyboardDoneToolbar()
        .scrollDismissesKeyboard(.interactively)
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
            // US-646: offer to resume an unsaved draft from a prior session.
            if !form.canSubmit, let draft = IntakeDraftStore.load() {
                pendingDraft = draft
            }
        }
        // US-646: autosave the form as the user types so a background-kill
        // doesn't lose work. Cleared on successful save / discard.
        .onChange(of: draftSignature) { _, _ in
            IntakeDraftStore.save(form)
        }
        // US-701: announce save outcome (success / saved-offline / failed) so
        // VoiceOver users hear it — the banner is a plain Section otherwise.
        .onChange(of: bannerMessage) { _, newValue in
            if let newValue { A11yAnnounce.announce(newValue.text) }
        }
        .alert("Resume your unsaved item?", isPresented: showingDraftResumeBinding, presenting: pendingDraft) { draft in
            Button("Resume") {
                IntakeDraftStore.apply(draft, to: form)
                pendingDraft = nil
            }
            Button("Discard", role: .destructive) {
                IntakeDraftStore.clear()
                pendingDraft = nil
            }
        } message: { draft in
            Text("You have an unsaved \(draft.title.isEmpty ? "item" : "\"\(draft.title)\"") from \(draft.savedAt.formatted(.relative(presentation: .named))).")
        }
        .sheet(item: $sheet) { presented in
            switch presented {
            case .addSource:
                if let store = sourceStore, let userId = currentUserId() {
                    AddSourceSheet(store: store, userId: userId) { newId in
                        form.sourceId = newId
                    }
                }
            case .skuMerge(let existing):
                skuMergeSheet(existing)
            }
        }
        .fullScreenCover(isPresented: $showingBarcodeScanner) {
            BarcodeScanView { code in
                form.sku = code
            }
        }
        // Duplicate-SKU combine-into-existing (intake variant of the merge).
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
            applyDictatedNotes(newText)
        }
        // US-1230: the FINAL recognition segment arrives on `finalizedText`
        // because the recognizer flips `isRecording` to false in the same
        // main-actor turn that delivers it — the partial-stream handler above
        // would drop it behind its `isRecording` guard. Apply it here so the
        // user's last spoken words land in Notes.
        .onChange(of: dictation.finalizedText) { _, finalText in
            guard let finalText, !finalText.isEmpty else { return }
            applyDictatedNotes(finalText)
        }
    }

    /// Merge a dictation transcript into the notes snapshot captured when
    /// dictation started. Extends pre-existing text rather than overwriting it.
    /// Pure (no view state) so it's unit-testable.
    static func mergedDictationNotes(anchor: String, transcript: String) -> String {
        guard !anchor.isEmpty else { return transcript }
        let separator = anchor.hasSuffix(" ") ? "" : " "
        return anchor + separator + transcript
    }

    private func applyDictatedNotes(_ transcript: String) {
        form.notes = Self.mergedDictationNotes(
            anchor: notesAnchorBeforeDictation, transcript: transcript)
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

    /// US-1201: true when the dictation failure is a denied mic/speech
    /// permission, which is only recoverable via Settings.
    private func isDictationPermissionDenied(_ error: Error) -> Bool {
        switch error as? SpeechDictation.DictationError {
        case .speechPermissionDenied, .microphonePermissionDenied: return true
        default: return false
        }
    }

    // MARK: - Sections

    private var itemSection: some View {
        Section("Item") {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 4) {
                    TextField("Title", text: $form.title)
                        .textInputAutocapitalization(.words)
                        .focused($focusedField, equals: .title)
                        .submitLabel(.next)
                        .onSubmit { focusedField = .sku }
                        // US-754: enforce the soft length cap as the user types so
                        // a long paste is visibly clamped, not silently dropped.
                        .onChange(of: form.title) { _, _ in form.clampTitleToLimit() }
                        .accessibilityLabel("Title, required")
                    Spacer(minLength: 4)
                    // US-754: length counter — appears only as the cap nears so
                    // it's not visual noise during normal entry.
                    if form.titleFeedback.level != .normal {
                        Text(form.titleFeedback.counterText)
                            .font(.caption2.weight(.semibold).monospacedDigit())
                            .foregroundStyle(form.titleFeedback.level == .atLimit
                                             ? Color.brandRed : Color.brandAmber)
                            .accessibilityHidden(true)
                    }
                    // Visual "required" marker — the field carries the label
                    // for VoiceOver, so this stays decorative.
                    Text("Required")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Color.brandRed)
                        .accessibilityHidden(true)
                }
                if let message = form.titleValidationMessage {
                    // US-754: red FieldError (web parity) — explains why both Save
                    // buttons are disabled; clears the moment a title is typed.
                    FieldError(message)
                } else if let atLimit = form.titleFeedback.atLimitNote {
                    // At the cap: explain the truncation rather than silently
                    // swallowing further keystrokes.
                    Text(atLimit)
                        .font(.footnote)
                        .foregroundStyle(Color.brandAmber)
                }
            }
            // US-754: announce the validation error to VoiceOver when it appears
            // (e.g. the user clears the title), reusing A11yAnnounce — onChange
            // doesn't fire on first render, so the initial empty state stays
            // silent until the user actually interacts.
            .onChange(of: form.titleValidationMessage) { _, newValue in
                if let newValue { A11yAnnounce.announce(newValue) }
            }
            // Announce the at-cap note once the field hits the limit.
            .onChange(of: form.titleFeedback.atLimitNote) { _, newValue in
                if let newValue { A11yAnnounce.announce(newValue) }
            }

            HStack {
                TextField("SKU", text: $form.sku)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focusedField, equals: .sku)
                    .submitLabel(.next)
                    .onSubmit { focusedField = .brand }
                Button {
                    AppRouter.haptic()
                    showingBarcodeScanner = true
                } label: {
                    Image(systemName: "barcode.viewfinder")
                        .scaledIconFont(size: 20)
                        .foregroundStyle(Color.brandNavy)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Scan barcode for SKU")
            }

            TextField("Brand", text: $form.brand)
                .textInputAutocapitalization(.words)
                .focused($focusedField, equals: .brand)
                .submitLabel(.next)
                .onSubmit { focusedField = .style }

            TextField("Style", text: $form.style)
                .textInputAutocapitalization(.sentences)
                .focused($focusedField, equals: .style)
                .submitLabel(.next)
                .onSubmit { focusedField = .size }

            TextField("Size", text: $form.size)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focusedField, equals: .size)
                .submitLabel(.next)
                .onSubmit { focusedField = .color }

            TextField("Color", text: $form.color)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focusedField, equals: .color)
                .submitLabel(.next)
                .onSubmit { focusedField = .material }

            TextField("Material", text: $form.material)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focusedField, equals: .material)
                .submitLabel(.next)
                .onSubmit { focusedField = .container }

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
                .focused($focusedField, equals: .container)
                .submitLabel(.next)
                .onSubmit { focusedField = .sourcedBy }

            TextField("Sourced by", text: $form.sourcedBy)
                .textInputAutocapitalization(.words)
                .focused($focusedField, equals: .sourcedBy)
                .submitLabel(.next)
                .onSubmit { focusedField = .purchasePrice }

            DatePicker(
                "Purchase date",
                selection: $form.purchaseDate,
                displayedComponents: .date
            )

            HStack {
                Text(currencyFormatter.symbol)
                    .foregroundStyle(.secondary)
                // decimalPad has no Return key, so this is the end of the
                // keyboard-driven traversal; .done dismisses.
                TextField("Purchase price", text: $form.purchasePriceText)
                    .keyboardType(.decimalPad)
                    .focused($focusedField, equals: .purchasePrice)
                    .submitLabel(.done)
                    .onSubmit { focusedField = nil }
            }
        }
    }

    private var sourcePicker: some View {
        Picker("Source", selection: $form.sourceId) {
            Text("None").tag(String?.none)
            // US-814: archived sources stay linked to their historical items but
            // are hidden from the intake picker. Keep a still-selected source
            // visible so an edited item doesn't silently lose its attribution.
            ForEach(sources.filter { !$0.isArchived || $0.id == form.sourceId }, id: \.id) { source in
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
                sheet = .addSource
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
                            .scaledIconFont(size: 22)
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
                VStack(alignment: .leading, spacing: 6) {
                    Text(error.localizedDescription)
                        .font(.footnote)
                        .foregroundStyle(.red)
                    // US-1201: a denied mic/speech permission can only be undone
                    // in Settings — give the user a direct path, not just a hint.
                    if isDictationPermissionDenied(error) {
                        Button("Open Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) {
                                UIApplication.shared.open(url)
                            }
                        }
                        .font(.footnote.weight(.semibold))
                    }
                }
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
        .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
    }

    private func secondaryButtonLabel(title: String) -> some View {
        Text(title)
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(Color(uiColor: .secondarySystemBackground))
            .foregroundStyle(Color.brandNavy)
            .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
    }

    private func bannerIcon(for kind: BannerMessage.Kind) -> String {
        switch kind {
        case .success: return "checkmark.circle.fill"
        case .offline: return "wifi.slash"
        case .failure: return "exclamationmark.triangle.fill"
        }
    }

    private func bannerColor(for kind: BannerMessage.Kind) -> Color {
        // US-653: brand tokens instead of system semantic colors.
        switch kind {
        case .success: return .brandEmerald
        case .offline: return .brandAmber
        case .failure: return .brandRed
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

        // US-670: write into the active workspace (member with listing_manager+
        // can insert under the owner's user_id; RLS enforces the role). Falls
        // back to self in the personal workspace.
        let ownerId = WorkspaceScope.tenantOwnerId(selfId: userId)

        // Pre-check for a duplicate SKU BEFORE inserting: if this SKU already
        // belongs to an item, offer to combine the new details into it (web
        // parity) instead of letting the insert dead-end on
        // idx_inventory_items_user_sku. Status is excluded from the merge — a
        // re-catalog must never silently regress a listed/sold item's status.
        let sku = form.sku.trimmingCharacters(in: .whitespacesAndNewlines)
        if !sku.isEmpty, let existing = await fetchExistingSkuOwner(sku, ownerId: ownerId) {
            skuMergeConflicts = ItemMergePlan
                .conflicts(current: intakeFormDraft(), existing: existing, formatter: currencyFormatter)
                .filter { $0.field != .status }
            pendingMergeOutcome = outcome
            skuMergeError = nil
            sheet = .skuMerge(existing)  // presents the combine sheet
            HapticFeedback.warning()
            return
        }

        let payload = buildInsertPayload(userId: ownerId)
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
                // US-1025: friendly copy in the banner; raw technical detail
                // (RLS denial, enum mismatch, …) goes to Sentry, not the UI.
                let detail = FriendlyErrorCopy.rawDetail(for: error)
                Telemetry.breadcrumb("Intake save failed: \(detail)", category: "intake")
                Telemetry.event("intake_save_error", props: ["detail": detail])
                bannerMessage = BannerMessage(
                    kind: .failure,
                    text: FriendlyErrorCopy.actionMessage(
                        for: error,
                        fallback: "Couldn't save your item. Please try again."
                    )
                )
            }
        }
    }

    /// Looks up the item that already owns `sku` in this workspace (US-268
    /// tenant scope), pulling the columns the combine flow reconciles or
    /// gap-fills. Returns nil when none exists or the query fails (the caller
    /// then proceeds with a normal insert).
    private func fetchExistingSkuOwner(_ sku: String, ownerId: String) async -> ExistingSkuItem? {
        do {
            let rows: [ExistingSkuItem] = try await SupabaseShared.client
                .from("inventory_items")
                .select(
                    "id,title,brand,size,color,material,condition_notes,status,item_category,target_price,acquired_price,location_bin,style,container,sourced_by,description,acquired_date,source_id"
                )
                .eq("user_id", value: ownerId)
                .eq("sku", value: sku)
                .limit(1)
                .execute()
                .value
            return rows.first
        } catch {
            return nil
        }
    }

    /// Maps the intake form into the shared `ItemDraft` shape so the merge sheet
    /// and `ItemMergePlan` can reconcile it against the existing item. Only the
    /// fields the merge UI covers are populated; notes live in `description`
    /// (not `condition_notes`) and intake captures purchase, not target, price.
    private func intakeFormDraft() -> ItemDraft {
        ItemDraft(
            title: form.title.trimmingCharacters(in: .whitespacesAndNewlines),
            brand: form.brand,
            sku: form.sku,
            size: form.size,
            color: form.color,
            material: form.material,
            conditionNotes: "",
            status: form.status.rawValue,
            category: form.category,
            targetPriceText: "",
            acquiredPriceText: form.purchasePriceText,
            locationBin: "",
            consignorId: nil,
            consignmentSplitText: ""
        )
    }

    /// Confirmed "combine into existing": UPDATE the existing item with the
    /// reconciled shared fields (never nulling a populated column) and gap-fill
    /// the extra intake-only fields where the existing record is blank. No row
    /// is inserted, so there are no children to re-point — a plain update is
    /// enough (no RPC). Status and SKU are intentionally left untouched.
    private func confirmIntakeMerge(existing: ExistingSkuItem, keepExisting: Set<ItemMergeField>) async {
        guard let userId = currentUserId() else {
            skuMergeError = "Sign in expired. Sign in again to save."
            return
        }
        let sku = form.sku.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sku.isEmpty else { return }
        isMergingSku = true
        skuMergeError = nil

        var resolved = intakeFormDraft()
        ItemMergePlan.apply(keepExisting, from: existing, to: &resolved, formatter: currencyFormatter)

        // Gap-fill helper: take the form's value only where the existing column
        // is empty, so combining never overwrites data already on the item.
        func gapFill(_ formValue: String, into existingValue: String?) -> String? {
            (existingValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? formValue.nonEmpty : nil
        }

        // Custom encode so nil fields are OMITTED (not sent as JSON null). A
        // PATCH that included nulls would WIPE the existing item's columns —
        // the opposite of "combine". Only the keys we actually set are written.
        struct CombineUpdate: Encodable, Sendable {
            let title: String?
            let brand: String?
            let size: String?
            let color: String?
            let material: String?
            let item_category: String?
            let acquired_price: Double?
            let style: String?
            let container: String?
            let sourced_by: String?
            let description: String?
            let source_id: String?

            enum CodingKeys: String, CodingKey {
                case title, brand, size, color, material, item_category
                case acquired_price, style, container, sourced_by, description, source_id
            }

            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encodeIfPresent(title, forKey: .title)
                try c.encodeIfPresent(brand, forKey: .brand)
                try c.encodeIfPresent(size, forKey: .size)
                try c.encodeIfPresent(color, forKey: .color)
                try c.encodeIfPresent(material, forKey: .material)
                try c.encodeIfPresent(item_category, forKey: .item_category)
                try c.encodeIfPresent(acquired_price, forKey: .acquired_price)
                try c.encodeIfPresent(style, forKey: .style)
                try c.encodeIfPresent(container, forKey: .container)
                try c.encodeIfPresent(sourced_by, forKey: .sourced_by)
                try c.encodeIfPresent(description, forKey: .description)
                try c.encodeIfPresent(source_id, forKey: .source_id)
            }
        }
        let update = CombineUpdate(
            title: resolved.title.nonEmpty,
            brand: resolved.brand.nonEmpty,
            size: resolved.size.nonEmpty,
            color: resolved.color.nonEmpty,
            material: resolved.material.nonEmpty,
            item_category: resolved.category?.rawValue,
            // US-1184: a pasted "-5" parses negative (decimalPad has no minus,
            // but paste bypasses it) — clamp acquisition price to >= 0.
            acquired_price: currencyFormatter.parse(resolved.acquiredPriceText).map { max(0, $0) },
            style: gapFill(form.style, into: existing.style),
            container: gapFill(form.container, into: existing.container),
            sourced_by: gapFill(form.sourcedBy, into: existing.sourced_by),
            description: gapFill(form.notes, into: existing.description),
            source_id: (existing.source_id ?? "").isEmpty ? form.sourceId : nil
        )

        do {
            try await SupabaseShared.client
                .from("inventory_items")
                .update(update)
                .eq("id", value: existing.id)
                .eq("user_id", value: WorkspaceScope.tenantOwnerId(selfId: userId))
                .execute()
        } catch {
            isMergingSku = false
            skuMergeError = error.localizedDescription
            HapticFeedback.error()
            return
        }

        IntakeDraftStore.clear()
        isMergingSku = false
        sheet = nil
        HapticFeedback.success()
        NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
        bannerMessage = BannerMessage(kind: .success, text: "Combined into the existing item.")
        switch pendingMergeOutcome {
        case .dismiss:
            dismiss()
        case .addAnother:
            form.resetForBatchAddAnother()
            AppRouter.haptic()
        }
    }

    private func handleSavedSuccessfully(outcome: SaveOutcome) {
        // US-646: the work is committed (or queued) — drop the recovery draft.
        IntakeDraftStore.clear()
        bannerMessage = BannerMessage(kind: .success, text: "Saved.")
        HapticFeedback.success()
        Telemetry.event(TelemetryEvent.intakeCompleted, props: [
            "source": "details_first",
            "online": true,
        ])
        switch outcome {
        case .dismiss:
            dismiss()
        case .addAnother:
            form.resetForBatchAddAnother()
            AppRouter.haptic()
        }
    }

    private func handleSavedOffline(outcome: SaveOutcome) {
        // US-646: the item is durably queued (US-640) — drop the recovery draft.
        IntakeDraftStore.clear()
        bannerMessage = BannerMessage(
            kind: .offline,
            text: "Saved offline — will sync when you reconnect."
        )
        HapticFeedback.warning()
        Telemetry.event(TelemetryEvent.intakeCompleted, props: [
            "source": "details_first",
            "online": false,
        ])
        switch outcome {
        case .dismiss:
            dismiss()
        case .addAnother:
            form.resetForBatchAddAnother()
            AppRouter.haptic()
        }
    }

    private func isNetworkFailure(_ error: Error) -> Bool {
        // US-1004: classify by typed error / NSError domain+code via the shared
        // classifier — NOT by matching English substrings in
        // `localizedDescription`, which misclassified non-English offline
        // failures as app rejections and silently dropped the queued create.
        // A 4xx/validation rejection (PostgrestError, etc.) is not in
        // NSURLErrorDomain, so it still falls through and is surfaced, not queued.
        FriendlyErrorCopy.isOffline(error)
    }

    private func enqueueOfflineMutation(payload: ItemInsertPayload) {
        // Inject a client-generated id so the SyncEngine replay can UPSERT
        // (US-640) — a retry after a partial success then updates the same row
        // instead of creating a duplicate. `targetId` mirrors the id so the
        // pending-changes inspector (US-641) can name the row.
        guard let base = try? JSONEncoder().encode(payload),
              var dict = (try? JSONSerialization.jsonObject(with: base)) as? [String: Any] else { return }
        // Lowercased to match Postgres `uuid` normalization (see PhotoIntakeView):
        // an UPPERCASE client id would miss the case-sensitive sync-merge lookup
        // on pull-back and duplicate the row.
        let id = UUID().uuidString.lowercased()
        dict["id"] = id
        guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return }
        let mutation = LocalPendingMutation(
            kind: .createInventoryItem,
            payload: data,
            targetId: id
        )
        modelContext.insert(mutation)
        modelContext.saveOrLog("enqueueOfflineMutation")
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
            // US-1184: clamp a pasted negative acquisition price to >= 0.
            acquired_price: currencyFormatter.parse(form.purchasePriceText).map { max(0, $0) },
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
