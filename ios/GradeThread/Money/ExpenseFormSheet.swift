import SwiftUI

/// Add-expense form presented from the Money tab. Writes through
/// ``ExpenseStore`` (which carries `user_id` for the RLS INSERT).
struct ExpenseFormSheet: View {
    let store: ExpenseStore

    @Environment(\.dismiss) private var dismiss
    @Environment(AuthStore.self) private var authStore

    @State private var category: ExpenseCategory = .shippingSupplies
    @State private var amountText: String = ""
    @State private var spentOn: Date = .now
    @State private var note: String = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private let currency = CurrencyFormatter()

    private var parsedAmount: Double? {
        guard let value = currency.parse(amountText), value > 0 else { return nil }
        return value
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
                    HStack {
                        Text(currency.symbol).foregroundStyle(.secondary)
                        TextField("Amount", text: $amountText)
                            .keyboardType(.decimalPad)
                    }
                    DatePicker("Date", selection: $spentOn, displayedComponents: .date)
                }
                Section("Note") {
                    TextField("Optional", text: $note, axis: .vertical)
                        .lineLimit(1...3)
                }
                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
            }
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
        let failure = await store.create(
            category: category,
            amount: amount,
            description: note,
            spentOn: spentOn,
            userId: user.id.uuidString
        )
        if let failure {
            errorMessage = failure
            HapticFeedback.error()
        } else {
            HapticFeedback.success()
            dismiss()
        }
    }
}
