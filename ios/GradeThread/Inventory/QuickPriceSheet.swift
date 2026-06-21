import SwiftData
import SwiftUI

/// US-685 — quick target-price edit from an inventory row, without pushing the
/// full item canvas. Writes `target_price` through the user-session Supabase
/// client (RLS-scoped) and optimistically updates the local SwiftData row so
/// the list reflects it immediately, mirroring ItemCanvasView.save().
struct QuickPriceSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext

    let item: LocalInventoryItem

    @State private var priceText: String
    @State private var isSaving = false
    @State private var errorMessage: String?

    private let currency = CurrencyFormatter()

    init(item: LocalInventoryItem) {
        self.item = item
        // US-1162: seed with the locale formatter so the value round-trips on save
        // (the field is parsed back with CurrencyFormatter.parse).
        _priceText = State(initialValue: item.targetPrice.map { CurrencyFormatter().formatRaw($0) } ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        Text(currency.symbol)
                            .foregroundStyle(.secondary)
                        TextField("List price", text: $priceText)
                            .keyboardType(.decimalPad)
                            .font(.brandData(20, weight: .bold))
                    }
                } header: {
                    Text(item.title.isEmpty ? "Untitled item" : item.title)
                } footer: {
                    if let errorMessage {
                        Text(errorMessage).foregroundStyle(Color.brandRed)
                    }
                }
            }
            .keyboardDoneToolbar()
            .navigationTitle("Edit price")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(isSaving)
                }
            }
        }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        let value = currency.parse(priceText)
        struct PriceUpdate: Encodable { let target_price: Double? }
        do {
            try await SupabaseShared.client
                .from("inventory_items")
                .update(PriceUpdate(target_price: value))
                .eq("id", value: item.id)
                .execute()
            item.targetPrice = value
            modelContext.saveOrLog("save")
            HapticFeedback.success()
            dismiss()
        } catch {
            // US-1174: friendly copy instead of a raw PostgREST/Supabase error.
            errorMessage = FriendlyErrorCopy.actionMessage(for: error, fallback: "Couldn't update the price. Please try again.")
            HapticFeedback.error()
        }
    }
}
