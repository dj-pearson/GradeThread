import SwiftData
import SwiftUI

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
    @State private var spentOn: Date = .now
    @State private var note: String = ""
    /// US-750: optional inventory-item attribution (00266 link).
    @State private var linkedItemId: String?
    @State private var isSaving = false
    @State private var errorMessage: String?

    private let currency = CurrencyFormatter()

    private var parsedAmount: Double? {
        MoneyFieldValidation.positiveAmount(amountText, formatter: currency)
    }

    var body: some View {
        NavigationStack {
            Form {
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
                    DatePicker("Date", selection: $spentOn, displayedComponents: .date)
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
            .navigationTitle("Add expense")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
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
            .onAppear {
                // US-750: honor a preset attribution (e.g. opened from an item).
                if linkedItemId == nil, let presetInventoryItemId {
                    linkedItemId = presetInventoryItemId
                }
            }
        }
    }

    private func save() async {
        guard let amount = parsedAmount else { return }
        guard case let .signedIn(user) = authStore.phase else {
            errorMessage = "Sign in expired. Sign in again to save."
            return
        }
        isSaving = true
        defer { isSaving = false }
        let result = await store.create(
            category: category,
            amount: amount,
            description: note,
            spentOn: spentOn,
            inventoryItemId: linkedItemId,
            userId: user.id.uuidString,
            queueContext: modelContext
        )
        switch result {
        case .saved:
            HapticFeedback.success()
            dismiss()
        case .savedOffline:
            // US-982: durably queued — it shows in the list and syncs on reconnect.
            HapticFeedback.warning()
            dismiss()
        case .failed(let message):
            errorMessage = message
            HapticFeedback.error()
        }
    }
}
