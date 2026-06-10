import SwiftUI
import SwiftData

/// Edit a LIVE eBay listing in place — title / price / description — and push
/// the revision (plus the current photo order) back to eBay.
///
/// eBay blocks editing inventory-based listings on its own site ("Inventory-
/// based listing management is not currently supported by this tool"), and
/// rotating/editing a photo there triggers "A mixture of Self Hosted and EPS
/// pictures are not allowed". This sheet is the supported path: it re-PUTs the
/// inventory item so every image stays self-hosted and the edits land cleanly.
/// Reorder/rotate photos in the photo manager; submitting here re-syncs them.
struct ReviseListingSheet: View {
    let item: LocalInventoryItem
    let listing: LocalListing

    @Environment(\.dismiss) private var dismiss
    private let service = EbayPublishService()

    @State private var title: String
    @State private var description: String
    @State private var priceText: String
    @State private var phase: Phase = .editing

    private enum Phase: Equatable {
        case editing
        case submitting
        case succeeded
        case failed(String)
    }

    private static let titleLimit = 80

    init(item: LocalInventoryItem, listing: LocalListing) {
        self.item = item
        self.listing = listing
        _title = State(initialValue: String(item.title.prefix(Self.titleLimit)))
        _description = State(initialValue: "")
        _priceText = State(initialValue: Self.formatPrice(listing.listingPrice))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title", text: $title, axis: .vertical)
                        .lineLimit(1...3)
                        .onChange(of: title) { _, newValue in
                            if newValue.count > Self.titleLimit {
                                title = String(newValue.prefix(Self.titleLimit))
                            }
                        }
                } header: {
                    Text("Title")
                } footer: {
                    Text("\(title.count)/\(Self.titleLimit)")
                }

                Section("Price (USD)") {
                    TextField("0.00", text: $priceText)
                        .keyboardType(.decimalPad)
                }

                Section {
                    TextField(
                        "Leave blank to keep the current description",
                        text: $description,
                        axis: .vertical
                    )
                    .lineLimit(4...12)
                } header: {
                    Text("Description")
                } footer: {
                    Text("Only sent to eBay if you type something here.")
                }

                Section {
                    Button {
                        AppRouter.haptic()
                        Task { await submit() }
                    } label: {
                        HStack(spacing: 6) {
                            if phase == .submitting {
                                ProgressView().controlSize(.small)
                            }
                            Text("Submit revision to eBay")
                                .font(.subheadline.weight(.semibold))
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .disabled(
                        phase == .submitting
                            || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
                } footer: {
                    Text("Pushes your edits and the current photo order to the live eBay listing. Reorder or rotate photos in the photo manager first.")
                }

                if case let .failed(message) = phase {
                    Section {
                        Label(message, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                            .font(.footnote)
                    }
                }
            }
            .navigationTitle("Edit live listing")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }.disabled(phase == .submitting)
                }
            }
            .alert(
                "Revision submitted",
                isPresented: Binding(
                    get: { phase == .succeeded },
                    set: { if !$0 { phase = .editing } }
                )
            ) {
                Button("Done") { dismiss() }
            } message: {
                Text("Your changes and photo order were pushed to eBay.")
            }
        }
    }

    private func submit() async {
        phase = .submitting
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedDesc = description.trimmingCharacters(in: .whitespacesAndNewlines)
        let parsedPrice = Double(priceText.replacingOccurrences(of: ",", with: ""))

        let titleChanged = !trimmedTitle.isEmpty && trimmedTitle != item.title
        let priceChanged =
            parsedPrice != nil && parsedPrice! > 0 && parsedPrice! != listing.listingPrice

        let outcome = await service.revise(
            listingId: listing.id,
            title: titleChanged ? trimmedTitle : nil,
            description: trimmedDesc.isEmpty ? nil : trimmedDesc,
            price: priceChanged ? parsedPrice : nil,
            syncPhotos: true
        )
        switch outcome {
        case .revised:
            HapticFeedback.success()
            phase = .succeeded
        case .noOfferId:
            phase = .failed("This listing has no eBay offer yet. Publish it first, then edit.")
        case .failed(let message):
            HapticFeedback.error()
            phase = .failed(message)
        }
    }

    private static func formatPrice(_ value: Double) -> String {
        value > 0 ? String(format: "%.2f", value) : ""
    }
}
