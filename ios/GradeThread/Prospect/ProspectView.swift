import SwiftUI
import PhotosUI

/// Item Prospecting (US-1107): the in-store "should I buy this?" scan. Snap the
/// front + the brand/size tag and the app identifies the item, counts how many
/// comps are out there, shows the going rate, and forecasts how fast it sells —
/// no typing required. Optionally enter what you'd pay for a buy/skip verdict.
struct ProspectView: View {
    let router: AppRouter

    // US-1180: @Observable store via @State (was @StateObject/ObservableObject).
    @State private var store = ProspectStore()
    @Environment(\.dismiss) private var dismiss
    @State private var showCamera = false
    @State private var showLibrary = false
    // US-1225: surface a library pick that fails to load instead of a silent
    // no-op (mirrors Snap's loadError pattern from US-1181).
    @State private var loadError: String?

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
                            // US-1225: once a result exists, entering/changing the
                            // cost needs a re-run for the verdict (ROI is computed
                            // server-side), so relabel the CTA to invite it.
                            Label(store.costNeedsRerun ? "Re-run for buy / skip verdict" : "Find comps",
                                  systemImage: store.costNeedsRerun ? "arrow.clockwise" : "magnifyingglass")
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
                // US-1866: Thrift Radar lives inside Prospect because it answers
                // the question one step BEFORE a scan — "is this store worth
                // walking into?" — off the scans this same screen produces.
                // Opening it enrols nobody: viewing and contributing are
                // separate consents.
                ToolbarItem(placement: .primaryAction) {
                    NavigationLink {
                        RadarNearbyView()
                    } label: {
                        Label("Nearby", systemImage: "dot.radiowaves.left.and.right")
                    }
                }
            }
            .sheet(isPresented: $showLibrary) {
                PhotoLibraryPicker(selectionLimit: max(1, ProspectStore.maxPhotos - store.images.count)) { results in
                    showLibrary = false
                    Task {
                        for result in results {
                            if let img = await result.loadImage() {
                                await MainActor.run { store.addImage(img) }
                            } else {
                                // US-1225: don't silently swallow a failed load.
                                await MainActor.run {
                                    loadError = "Couldn't load that photo — it may still be downloading from iCloud. Try again or pick another."
                                }
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
            .alert(
                "Couldn't load photo",
                isPresented: Binding(get: { loadError != nil }, set: { if !$0 { loadError = nil } })
            ) {
                Button("OK") { loadError = nil }
            } message: {
                Text(loadError ?? "")
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
                // US-1180: key by the UIImage's (identity-based) hash, not the
                // array offset, so removing a non-last photo doesn't mis-animate
                // / reuse identities.
                ForEach(Array(store.images.enumerated()), id: \.element) { index, image in
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
                            .accessibilityLabel("Remove photo")
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
        // US-1180: @Bindable yields a two-way binding from the @Observable store.
        @Bindable var store = store
        return VStack(alignment: .leading, spacing: 4) {
            TextField("What would you pay? (optional)", text: $store.costText)
                .keyboardType(.decimalPad)
                .textFieldStyle(.roundedBorder)
                // US-1522: decimalPad has no return key — add a Done toolbar so the
                // keyboard can be dismissed (matches the other numeric fields).
                .keyboardDoneToolbar()
            if store.costNeedsRerun {
                // US-1225: the verdict is server-computed for the cost it ran with,
                // so a cost entered/changed after a run needs a re-run to take.
                Text("Re-run to apply this cost to the buy / skip verdict.")
                    .font(.caption2)
                    .foregroundStyle(Color.brandAmber)
            } else {
                Text("Enter your cost for a buy / skip verdict and ROI.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
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
            // US-1170: show the brand the AI read off the tag so the user can
            // sanity-check the identification before committing a purchase.
            if let brand = result.item.brand, !brand.isEmpty,
               brand.caseInsensitiveCompare(result.item.title ?? "") != .orderedSame {
                Text(brand)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.brandNavy)
            }
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
                    .font(.brandData(36, weight: .bold))
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
            // US-1170: surface the ROI math the AI computed (only present once a
            // cost was entered) instead of hiding it behind the verdict.
            if decision.estProceedsCents != nil || decision.estMarginCents != nil
                || decision.roiPct != nil || decision.breakevenCents != nil {
                VStack(spacing: 2) {
                    if let p = decision.estProceedsCents { metricRow("Est. proceeds", dollars(p)) }
                    if let m = decision.estMarginCents { metricRow("Est. margin", dollars(m)) }
                    if let r = decision.roiPct { metricRow("ROI", "\(Int(r.rounded()))%") }
                    if let b = decision.breakevenCents { metricRow("Breakeven price", dollars(b)) }
                }
                .padding(.top, 2)
            }
        }
    }

    private func metricRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(.caption.weight(.semibold)).monospacedDigit()
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
            VStack(alignment: .leading, spacing: 8) {
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

                // US-1225: add-to-inventory has its OWN error + retry, so the
                // retry re-calls addToInventory() — not the billable run() that
                // the top error card's "Try again" triggers.
                if let addError = store.addError {
                    Text(addError)
                        .font(.footnote)
                        .foregroundStyle(Color.brandRed)
                    Button("Try again") { Task { await store.addToInventory() } }
                        .font(.footnote.weight(.semibold))
                        .buttonStyle(.bordered)
                        .disabled(store.isAdding)
                }
            }
        }
    }

    // MARK: - Helpers

    private func dollars(_ cents: Int?) -> String {
        guard let cents else { return "—" }
        // US-1161: full cents + locale currency, not integer-truncated "$".
        return CurrencyFormatter.shared.formatDisplay(Double(cents) / 100)
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
