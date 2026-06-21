import SwiftUI
import PhotosUI

/// Item Prospecting (US-1107): the in-store "should I buy this?" scan. Snap the
/// front + the brand/size tag and the app identifies the item, counts how many
/// comps are out there, shows the going rate, and forecasts how fast it sells —
/// no typing required. Optionally enter what you'd pay for a buy/skip verdict.
struct ProspectView: View {
    let router: AppRouter

    @StateObject private var store = ProspectStore()
    @Environment(\.dismiss) private var dismiss
    @State private var showCamera = false
    @State private var showLibrary = false

    private var cameraAvailable: Bool {
        UIImagePickerController.isSourceTypeAvailable(.camera)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Snap the item and its brand/size tag. We'll identify it and pull eBay comps — how many are out there, the going rate, and how fast it sells.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                    photoStrip
                    captureButtons
                    costField

                    Button {
                        AppRouter.haptic()
                        Task { await store.run() }
                    } label: {
                        if store.isLoading {
                            ProgressView().frame(maxWidth: .infinity)
                        } else {
                            Label("Find comps", systemImage: "magnifyingglass")
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(.brandPrimary)
                    .disabled(!store.canRun)

                    if let message = store.errorMessage {
                        // US-1163: offer a retry instead of a dead-end red line.
                        VStack(alignment: .leading, spacing: 8) {
                            Text(message)
                                .font(.footnote)
                                .foregroundStyle(Color.brandRed)
                            Button("Try again") { Task { await store.run() } }
                                .font(.footnote.weight(.semibold))
                                .buttonStyle(.bordered)
                                .disabled(!store.canRun)
                        }
                    }

                    if let result = store.result {
                        resultCard(result)
                    }
                }
                .padding()
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Prospect")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .sheet(isPresented: $showLibrary) {
                PhotoLibraryPicker(selectionLimit: max(1, ProspectStore.maxPhotos - store.images.count)) { results in
                    showLibrary = false
                    Task {
                        for result in results {
                            if let img = await result.loadImage() {
                                await MainActor.run { store.addImage(img) }
                            }
                        }
                    }
                }
                .ignoresSafeArea()
            }
            .fullScreenCover(isPresented: $showCamera) {
                CameraPicker { img in store.addImage(img) }
                    .ignoresSafeArea()
            }
        }
    }

    // MARK: - Capture

    @ViewBuilder private var photoStrip: some View {
        if store.images.isEmpty {
            RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous)
                .fill(Color.secondary.opacity(0.1))
                .frame(height: 200)
                .overlay {
                    VStack(spacing: 8) {
                        Image(systemName: "camera.viewfinder").font(.system(size: 34))
                        Text("Add the front + the tag").font(.subheadline)
                    }
                    .foregroundStyle(.secondary)
                }
        } else {
            HStack(spacing: 10) {
                ForEach(Array(store.images.enumerated()), id: \.offset) { index, image in
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 150, height: 200)
                        .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
                        .overlay(alignment: .topTrailing) {
                            Button {
                                AppRouter.haptic()
                                store.removeImage(at: index)
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.title3)
                                    .foregroundStyle(.white, .black.opacity(0.5))
                            }
                            .padding(6)
                        }
                }
            }
        }
    }

    @ViewBuilder private var captureButtons: some View {
        if store.canAddPhoto {
            HStack(spacing: 10) {
                if cameraAvailable {
                    Button {
                        AppRouter.haptic()
                        showCamera = true
                    } label: {
                        Label("Take photo", systemImage: "camera.fill").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
                Button {
                    AppRouter.haptic()
                    showLibrary = true
                } label: {
                    Label("Library", systemImage: "photo.on.rectangle").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
            .tint(Color.brandNavy)
        }
    }

    private var costField: some View {
        VStack(alignment: .leading, spacing: 4) {
            TextField("What would you pay? (optional)", text: $store.costText)
                .keyboardType(.decimalPad)
                .textFieldStyle(.roundedBorder)
            Text("Enter your cost for a buy / skip verdict and ROI.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Result

    @ViewBuilder private func resultCard(_ result: ProspectResponse) -> some View {
        if !result.identified {
            VStack(alignment: .leading, spacing: 8) {
                Label("Couldn't identify the item", systemImage: "questionmark.circle")
                    .font(.headline)
                Text(result.note ?? "Try a sharper photo of the brand/size tag.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: CornerRadius.control))
        } else {
            VStack(alignment: .leading, spacing: 14) {
                identityHeader(result)
                Divider()
                priceBlock(result)
                if let st = result.sellThrough, st.label != "unknown" {
                    sellThroughBlock(st)
                }
                if let decision = result.decision, result.costCents != nil {
                    decisionBlock(decision)
                }
                if let urlString = result.ebaySoldSearchUrl, let url = URL(string: urlString) {
                    Link(destination: url) {
                        Label("See sold comps on eBay", systemImage: "arrow.up.right.square")
                            .font(.footnote.weight(.medium))
                    }
                    .tint(Color.brandNavy)
                }
                if let disclaimer = result.disclaimer {
                    Text(disclaimer)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.brandAmber.opacity(0.12), in: RoundedRectangle(cornerRadius: CornerRadius.chip))
                }
                addToInventoryButton
            }
            .padding()
            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: CornerRadius.control))
        }
    }

    private func identityHeader(_ result: ProspectResponse) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(result.item.title ?? result.item.brand ?? "Item")
                .font(.brandTitle2)
            HStack(spacing: 8) {
                if let path = result.category?.path {
                    Text(path)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            if let grade = result.grade {
                Text("Est. grade \(String(format: "%.1f", grade.value))"
                    + (grade.tier.map { " · \($0.capitalized)" } ?? ""))
                    .font(.caption)
                    .foregroundStyle(GradeScale.color(for: grade.value))
            }
        }
    }

    @ViewBuilder private func priceBlock(_ result: ProspectResponse) -> some View {
        if let stats = result.stats, stats.sufficient, stats.medianCents != nil {
            VStack(alignment: .leading, spacing: 2) {
                Text(dollars(stats.medianCents))
                    .font(.system(size: 36, weight: .bold))
                    .foregroundStyle(Color.brandNavy)
                Text("going rate · range \(dollars(stats.lowCents))–\(dollars(stats.highCents))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("Based on \(stats.count) condition-matched \(result.source == "sold" ? "sold" : "active") listing\(stats.count == 1 ? "" : "s")")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        } else {
            VStack(alignment: .leading, spacing: 2) {
                Text("Not enough comps to price yet")
                    .font(.subheadline.weight(.medium))
                if let count = result.stats?.count {
                    Text("Only \(count) listing\(count == 1 ? "" : "s") found — too thin to trust.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func sellThroughBlock(_ st: ProspectSellThrough) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "speedometer").foregroundStyle(sellThroughColor(st.label))
            VStack(alignment: .leading, spacing: 1) {
                Text("Sells \(st.label) · ~\(Int((st.sellThroughPct * 100).rounded()))% likely")
                    .font(.subheadline.weight(.medium))
                Text("est. \(st.daysLow)–\(st.daysHigh) days at the going rate")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func decisionBlock(_ decision: ProspectDecision) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(decision.recommendation.uppercased())
                .font(.caption.weight(.bold))
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(recommendationColor(decision.recommendation).opacity(0.15),
                            in: Capsule())
                .foregroundStyle(recommendationColor(decision.recommendation))
            Text(decision.reason)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private var addToInventoryButton: some View {
        if store.addedItemId != nil {
            Button {
                AppRouter.haptic()
                dismiss()
                router.selection = .inventory
            } label: {
                Label("Added — view inventory", systemImage: "checkmark.circle.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.brandSecondary)
        } else {
            Button {
                AppRouter.haptic()
                Task { await store.addToInventory() }
            } label: {
                if store.isAdding {
                    ProgressView().frame(maxWidth: .infinity)
                } else {
                    Label("Add to inventory", systemImage: "plus.circle.fill")
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.brandPrimary)
            .disabled(store.isAdding)
        }
    }

    // MARK: - Helpers

    private func dollars(_ cents: Int?) -> String {
        guard let cents else { return "—" }
        // US-1161: full cents + locale currency, not integer-truncated "$".
        return CurrencyFormatter().formatDisplay(Double(cents) / 100)
    }

    private func sellThroughColor(_ label: String) -> Color {
        switch label {
        case "fast": return .green
        case "moderate": return Color.brandAmber
        case "slow": return Color.brandRed
        default: return .secondary
        }
    }

    private func recommendationColor(_ rec: String) -> Color {
        switch rec {
        case "buy": return .green
        case "maybe": return Color.brandAmber
        default: return Color.brandRed
        }
    }
}
