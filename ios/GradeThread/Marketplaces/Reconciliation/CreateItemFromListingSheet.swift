import SwiftUI

/// Modal form that pre-fills title + SKU + target price from the orphan
/// eBay listing. User can edit, then confirm — the service inserts a
/// new inventory_items row + flips the orphan to matched.
struct CreateItemFromListingSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AuthStore.self) private var authStore

    let orphan: OrphanEbayListing
    let service: ReconciliationService
    let onComplete: (ReconciliationOutcome) -> Void

    @State private var title: String
    @State private var sku: String
    @State private var targetPriceText: String
    @State private var isSaving = false
    @State private var errorMessage: String?
    // US-3267: the fields are SEEDED from the orphan listing, so dirty means
    // "differs from what we prefilled", not "is non-empty". The old guard was
    // `isSaving`, which never covered the edit itself.
    @State private var showingDiscard = false
    private let pristine: Pristine
    private let currencyFormatter = CurrencyFormatter()

    /// The prefilled values, kept so an untouched sheet still dismisses on a
    /// swipe the way an untouched sheet should.
    private struct Pristine: Equatable {
        let title: String
        let sku: String
        let targetPriceText: String
    }

    private var isDirty: Bool {
        isSaving
            || Pristine(title: title, sku: sku, targetPriceText: targetPriceText) != pristine
    }

    init(
        orphan: OrphanEbayListing,
        service: ReconciliationService,
        onComplete: @escaping (ReconciliationOutcome) -> Void
    ) {
        self.orphan = orphan
        self.service = service
        self.onComplete = onComplete
        _title = State(initialValue: orphan.suggestedTitle)
        _sku = State(initialValue: orphan.customLabel ?? "")
        let formatter = CurrencyFormatter()
        let seededPrice = orphan.currentPrice.map { formatter.formatRaw($0) } ?? ""
        _targetPriceText = State(initialValue: seededPrice)
        pristine = Pristine(
            title: orphan.suggestedTitle,
            sku: orphan.customLabel ?? "",
            targetPriceText: seededPrice
        )
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("eBay listing", value: orphan.ebayItemId)
                        .font(.subheadline)
                    if let url = orphan.listingURL.flatMap(URL.init(string:)) {
                        Link("View on eBay", destination: url)
                            .font(.subheadline.weight(.medium))
                    }
                } header: {
                    Text("Source")
                }

                Section("Item") {
                    TextField("Title", text: $title)
                        .textInputAutocapitalization(.words)
                    TextField("SKU", text: $sku)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    HStack {
                        Text(currencyFormatter.symbol).foregroundStyle(.secondary)
                        TextField("Target price", text: $targetPriceText)
                            .keyboardType(.decimalPad)
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
            .navigationTitle("Create item")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    CancelFormButton(isDirty: isDirty, showingDiscard: $showingDiscard) {
                        dismiss()
                    }
                    .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await save() }
                    } label: {
                        if isSaving { ProgressView() }
                        else { Text("Create").font(.subheadline.weight(.semibold)) }
                    }
                    .disabled(isSaving || trimmedTitle.isEmpty)
                }
            }
        }
        .unsavedChangesGuard(isDirty: isDirty, showingDiscard: $showingDiscard) { dismiss() }
    }

    // MARK: - Save

    private var trimmedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func currentUserId() -> String? {
        if case let .signedIn(user) = authStore.phase {
            return user.id.uuidString
        }
        return nil
    }

    private func save() async {
        guard let userId = currentUserId() else {
            errorMessage = "Sign in expired."
            return
        }
        isSaving = true
        defer { isSaving = false }

        let outcome = await service.createItem(
            from: orphan,
            userId: userId,
            title: trimmedTitle,
            sku: sku,
            targetPrice: currencyFormatter.parse(targetPriceText)
        )
        switch outcome.kind {
        case .created:
            // US-751: the parent (ReconciliationView.applyOutcome) drops the
            // resolved orphan AND triggers the targeted cache refresh that lands
            // the mirrored listing — no separate post needed here.
            onComplete(outcome)
            dismiss()
        case .failed(let message):
            errorMessage = message
        case .linked, .ignored:
            // createItem never returns these — guard anyway.
            errorMessage = "Unexpected outcome."
        }
    }
}
