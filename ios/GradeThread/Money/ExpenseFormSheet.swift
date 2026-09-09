import SwiftData
import SwiftUI
import UIKit

/// Add-expense form presented from the Money tab. Writes through
/// ``ExpenseStore`` (which carries `user_id` for the RLS INSERT).
struct ExpenseFormSheet: View {
    let store: ExpenseStore
    /// US-750: pre-select an item to attribute the cost to (e.g. opened from an
    /// item canvas). nil = the general Money-tab path with a manual picker.
    var presetInventoryItemId: String? = nil

    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Environment(AuthStore.self) private var authStore
    /// US-981: Add Expense durably queues offline (US-982), so we don't block
    /// Save — we just reassure the user it'll sync on reconnect.
    @Environment(NetworkMonitor.self) private var networkMonitor: NetworkMonitor?

    /// US-750: cached items for the optional "attribute to item" picker.
    @Query(sort: \LocalInventoryItem.updatedAt, order: .reverse)
    private var items: [LocalInventoryItem]

    @State private var category: ExpenseCategory = .shippingSupplies
    @State private var amountText: String = ""
    // US-3230: the seller's local day, anchored the way the column stores it.
    // Plain `.now` plus a UTC formatter on the way out meant an expense logged
    // at 9pm in Chicago was filed under tomorrow — and on 31 December, under
    // next year.
    @State private var spentOn: Date = MoneyDate.today()
    @State private var note: String = ""
    /// US-750: optional inventory-item attribution (00266 link).
    @State private var linkedItemId: String?
    @State private var isSaving = false
    @State private var errorMessage: String?

    // US-3014: reading a receipt. The scan PROPOSES; the fields below are what
    // the seller confirms, and nothing is written until they hit Save.
    @State private var scan = ReceiptScanViewModel()
    @State private var showCamera = false
    @State private var sheet: FormSheet?
    @State private var photoLoadError: String?

    // US-3220: an expense with a scanned receipt on it is real work. A stray
    // downward swipe used to bin it with no warning.
    @State private var showingDiscard = false

    /// Anything the seller has entered or scanned. The category has a default,
    /// so it doesn't count; a staged receipt does, since re-photographing it is
    /// the most annoying part to lose.
    private var isDirty: Bool {
        !amountText.trimmingCharacters(in: .whitespaces).isEmpty
            || !note.trimmingCharacters(in: .whitespaces).isEmpty
            || linkedItemId != nil
            || scan.stagingPath != nil
    }

    /// The one sheet this view presents, named so two of them cannot compete
    /// for the single slot (ios/Scripts/check-chained-sheets.py). The camera
    /// goes through `.fullScreenCover`, which is its own slot.
    private enum FormSheet: String, Identifiable {
        case library
        var id: String { rawValue }
    }

    private var cameraAvailable: Bool {
        UIImagePickerController.isSourceTypeAvailable(.camera)
    }

    private let currency = CurrencyFormatter()

    private var parsedAmount: Double? {
        MoneyFieldValidation.positiveAmount(amountText, formatter: currency)
    }

    var body: some View {
        NavigationStack {
            Form {
                // FIRST, because a receipt in your hand is the reason you opened
                // this screen. Below the fields it would be a feature nobody
                // finds until after they have typed everything in.
                Section {
                    if scan.isScanning {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text("Reading the receipt. This takes a few seconds.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        if cameraAvailable {
                            Button {
                                showCamera = true
                            } label: {
                                Label("Photograph a receipt", systemImage: "camera")
                            }
                        }
                        Button {
                            sheet = .library
                        } label: {
                            Label("Pick a photo of one", systemImage: "photo")
                        }
                    }
                    if let warning = scan.warning {
                        // The SERVER's sentence, shown as received. We did not
                        // write it and cannot localize it.
                        Text(warning)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    if let photoLoadError {
                        Text(photoLoadError)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                    if case let .failed(message) = scan.phase {
                        Text(message)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Have a receipt?")
                } footer: {
                    Text(scan.stagingPath == nil
                         ? "We read it and fill this in. You check it before anything is saved."
                         : "Your photo is saved and will be attached when you save this expense.")
                        .font(.footnote)
                }

                Section {
                    Picker("Category", selection: $category) {
                        ForEach(ExpenseCategory.allCases) { cat in
                            Label(cat.label, systemImage: cat.systemImage).tag(cat)
                        }
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(currency.symbol).foregroundStyle(.secondary)
                            TextField("Amount", text: $amountText)
                                .keyboardType(.decimalPad)
                        }
                        // US-970: explain why Save is disabled instead of leaving
                        // the button silently dead. Reuses the details-intake
                        // inline-help pattern (US-754).
                        if let help = MoneyFieldValidation.requiredAmountHelp(amountText, formatter: currency) {
                            Text(help)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    DatePicker(
                        "Date",
                        selection: MoneyDate.dayPicker($spentOn),
                        displayedComponents: .date
                    )
                }
                Section("Note") {
                    TextField("Optional", text: $note, axis: .vertical)
                        .lineLimit(1...3)
                }
                // US-750: optionally attribute this cost to one item so per-item
                // P&L reflects it. Default "Not tied to an item" = general overhead.
                Section {
                    Picker("Item", selection: $linkedItemId) {
                        Text("Not tied to an item").tag(String?.none)
                        ForEach(items) { item in
                            Text(item.title.isEmpty ? "Untitled item" : item.title)
                                .tag(String?.some(item.id))
                        }
                    }
                } header: {
                    Text("Attribute to item")
                } footer: {
                    Text("Linking an expense to an item counts it against that item's profit. Leave unset for general business overhead.")
                        .font(.footnote)
                }
                if NetworkMonitor.isOffline(networkMonitor) {
                    Section {
                        OfflineNotice(intent: .queued)
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                    }
                }
                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
            }
            .keyboardDoneToolbar()
            .scrollDismissesKeyboard(.interactively)
            .unsavedChangesGuard(isDirty: isDirty, showingDiscard: $showingDiscard) { dismiss() }
            .navigationTitle("Add expense")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    CancelFormButton(isDirty: isDirty, showingDiscard: $showingDiscard) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await save() }
                    } label: {
                        if isSaving { ProgressView() } else { Text("Save").bold() }
                    }
                    .disabled(parsedAmount == nil || isSaving)
                }
            }
            // ONE cover and ONE sheet on this chain. Two of either compete for
            // a single slot and the loser presents and tears down in the same
            // frame (ios/Scripts/check-chained-sheets.py).
            .fullScreenCover(isPresented: $showCamera) {
                CameraPicker { image in
                    Task { await readReceipt(image) }
                }
                .ignoresSafeArea()
            }
            .sheet(item: $sheet) { presented in
                switch presented {
                case .library:
                    PhotoLibraryPicker(selectionLimit: 1) { results in
                        sheet = nil
                        guard let first = results.first else { return }
                        Task {
                            guard let image = await first.loadImage() else {
                                // Never swallowed: an iCloud photo that has not
                                // finished downloading fails here, and silence
                                // reads as the button being broken.
                                await MainActor.run {
                                    photoLoadError = "Couldn't load that photo — it may still be downloading from iCloud. Try again or pick another."
                                }
                                return
                            }
                            await readReceipt(image)
                        }
                    }
                    .ignoresSafeArea()
                }
            }
            .onAppear {
                // US-750: honor a preset attribution (e.g. opened from an item).
                if linkedItemId == nil, let presetInventoryItemId {
                    linkedItemId = presetInventoryItemId
                }
            }
        }
    }

    /// US-3014: read a photographed receipt and pre-fill the form from it.
    ///
    /// PRE-FILL, NOT SAVE. Every field the model was unsure about is still
    /// filled in — blanking one would make the seller retype something the
    /// model got right — and the fields it was unsure about are named on
    /// screen so they get looked at.
    ///
    /// A field the seller has ALREADY typed into is never overwritten. The scan
    /// is an assistant, and an assistant that deletes your typing is worse than
    /// no assistant.
    private func readReceipt(_ image: UIImage) async {
        photoLoadError = nil
        await scan.scan(image: image)
        guard let prefill = scan.prefill else { return }
        if amountText.isEmpty { amountText = prefill.amountText }
        if note.isEmpty { note = prefill.note }
        if prefill.category != .other { category = prefill.category }
        spentOn = prefill.spentOn
        HapticFeedback.success()
    }

    private func save() async {
        guard let amount = parsedAmount else { return }
        guard case let .signedIn(user) = authStore.phase else {
            errorMessage = "Sign in expired. Sign in again to save."
            return
        }
        isSaving = true
        defer { isSaving = false }
        // Minted here so the staged receipt can be attached to this exact row
        // after the save. Lowercased at the mint site, for the reason
        // ExpenseStore.create's own comment gives.
        let expenseId = UUID().uuidString.lowercased()
        let result = await store.create(
            category: category,
            amount: amount,
            description: note,
            spentOn: spentOn,
            inventoryItemId: linkedItemId,
            userId: user.id.uuidString,
            id: expenseId,
            queueContext: modelContext
        )
        switch result {
        case .saved:
            // SAVE THEN ATTACH, and the attach is best effort. An expense with
            // no receipt is a correct expense; a receipt with no expense is a
            // file nobody ever finds. Only attempted on a server-confirmed
            // save: the adopt route looks the expense up by id, so running it
            // against a row that is still sitting in the offline queue would
            // 404 and burn the staged file for nothing.
            await scan.attach(toExpenseId: expenseId)
            HapticFeedback.success()
            dismiss()
        case .savedOffline:
            // US-982: durably queued — it shows in the list and syncs on reconnect.
            // The staged photo stays where it is; the seller can attach it from
            // the expense once the row lands.
            HapticFeedback.warning()
            dismiss()
        case .failed(let message):
            errorMessage = message
            HapticFeedback.error()
        }
    }
}
