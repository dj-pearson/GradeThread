import SwiftUI

/// Record a sale against an item: what it sold for, what it cost to sell, and
/// what is left.
///
/// This is the ONLY way an item becomes sold on iOS. The status picker on the
/// item page no longer offers the word, because a status with no sale behind it
/// leaves the books disagreeing with inventory and says nothing about it.
struct RecordSaleSheet: View {
    let itemTitle: String
    let itemId: String
    let currentStatus: String
    /// Seeded into the sale price, since the asking price is usually the answer.
    let listedPrice: Double?
    /// What the seller paid. Not editable here; it drives the net figure.
    let purchasePrice: Double?
    let listing: SaleRecorder.ListingRef?
    /// Handed the recorded outcome so the caller can update the item in place.
    let onRecorded: (SaleRecorder.Outcome) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var form = RecordSaleForm()
    @State private var saving = false
    @State private var errorMessage: String?
    private let currencyFormatter = CurrencyFormatter()

    private var parse: (String) -> Double? { currencyFormatter.parse }

    private var net: Double {
        form.netProfit(purchasePrice: purchasePrice ?? 0, parse: parse)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(itemTitle)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.secondary)
                }
                Section {
                    money("Sale price", text: $form.salePrice)
                    money("Shipping the buyer paid", text: $form.shippingCollected)
                } header: {
                    Text("Money in")
                } footer: {
                    Text("What the buyer paid you, before fees.")
                }

                Section {
                    money("Platform fees", text: $form.platformFees)
                    money("Payment processing", text: $form.paymentProcessingFees)
                    money("Shipping you paid", text: $form.shippingCost)
                    money("Tax", text: $form.tax)
                    money("Other costs", text: $form.otherCosts)
                } header: {
                    Text("Money out")
                } footer: {
                    Text("Leave a line blank if it doesn't apply. Blank counts as zero.")
                }

                Section {
                    LabeledContent("Item cost") {
                        Text(currencyFormatter.formatDisplay(purchasePrice ?? 0))
                            .foregroundStyle(.secondary)
                    }
                    LabeledContent("You keep") {
                        Text(currencyFormatter.formatDisplay(net))
                            .font(.body.weight(.semibold))
                            .foregroundStyle(net < 0 ? Color.brandRed : Color.brandNavy)
                    }
                } footer: {
                    if purchasePrice == nil {
                        Text("No purchase price on this item, so the total treats it as free. Set one on the item to make this figure real.")
                    } else {
                        Text("Everything in, minus everything out, minus what you paid for it.")
                    }
                }

                Section("Details") {
                    DatePicker(
                        "Sale date", selection: $form.saleDate, displayedComponents: .date
                    )
                    TextField("Buyer username (optional)", text: $form.buyerUsername)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }

                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(Color.brandRed)
                    }
                }

                if listing != nil {
                    Section {
                        Label(
                            "Recording this also closes the listing so it can't sell twice.",
                            systemImage: "info.circle"
                        )
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Record sale")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Record") { Task { await recordSale() } }
                        .disabled(saving)
                }
            }
            .interactiveDismissDisabled(saving)
            .onAppear {
                if form.salePrice.isEmpty, let listedPrice, listedPrice > 0 {
                    // formatRaw, not formatDisplay: this seeds an EDITABLE
                    // field, and a currency symbol typed back into it would
                    // fail the parse on save.
                    form.salePrice = currencyFormatter.formatRaw(listedPrice)
                }
            }
        }
    }

    private func money(_ label: String, text: Binding<String>) -> some View {
        LabeledContent(label) {
            HStack(spacing: 4) {
                Text(currencyFormatter.symbol).foregroundStyle(.secondary)
                TextField("0", text: text)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
            }
        }
    }

    private func recordSale() async {
        // The button's own disabled state only applies on the NEXT render, so a
        // fast double tap could insert two sales rows and double the revenue.
        // Flip the flag before the first await instead.
        guard !saving else { return }
        if let problem = form.validationError(parse: parse) {
            errorMessage = problem
            HapticFeedback.error()
            return
        }
        errorMessage = nil
        saving = true
        defer { saving = false }

        let outcome = await SaleRecorder().record(
            itemId: itemId,
            currentStatus: currentStatus,
            listing: listing,
            values: SaleValues(form: form, parse: parse),
            netProfit: net
        )
        guard outcome.recorded else {
            errorMessage = outcome.errorMessage ?? "Couldn't record the sale."
            HapticFeedback.error()
            return
        }
        HapticFeedback.success()
        onRecorded(outcome)
        dismiss()
    }
}
