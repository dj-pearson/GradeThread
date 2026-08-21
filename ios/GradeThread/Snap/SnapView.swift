import SwiftUI
import PhotosUI
import AVFoundation

/// Snap-to-Value (US-613): point the camera at a garment → instant condition
/// grade estimate + a condition-adjusted resale value range. Free + signup-
/// gated; the result nudges toward a certified grade or a FlipDesk listing.
struct SnapView: View {
    let router: AppRouter

    // US-1180: @Observable store via @State (was @StateObject/ObservableObject).
    @State private var store = SnapStore()
    @Environment(\.dismiss) private var dismiss
    @Environment(AuthStore.self) private var authStore
    @State private var showCamera = false
    /// One optional driving ONE `.sheet(item:)`. A view has a single sheet
    /// slot, so two `.sheet` modifiers on it compete for that slot and the
    /// loser presents and is torn down in the same frame - see ``ToolModule``
    /// and `Scripts/check-chained-sheets.py`. The camera is a
    /// `fullScreenCover`, a different presentation kind, so it stays as it is.
    @State private var sheet: SnapSheet?

    /// The sheets Snap-to-Value presents.
    private enum SnapSheet: String, Identifiable {
        /// Pick a garment photo from the library.
        case library
        /// US-2152: in-app paywall when a cap-reached snap offers upgrading.
        case paywall

        var id: String { rawValue }
    }
    // US-1181: recover gracefully when camera access was previously denied, and
    // surface a library pick that fails to load instead of a silent no-op.
    @State private var showCameraDeniedAlert = false
    @State private var loadError: String?

    private var cameraAvailable: Bool {
        UIImagePickerController.isSourceTypeAvailable(.camera)
    }

    private var currentUserId: UUID? {
        if case let .signedIn(user) = authStore.phase { return user.id }
        return nil
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Snap a photo of any garment for an instant AI condition grade and a resale value range.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                    photoArea
                    captureButtons
                    hintFields

                    Button {
                        AppRouter.haptic()
                        Task { await store.evaluate() }
                    } label: {
                        if store.isLoading {
                            ProgressView().frame(maxWidth: .infinity)
                        } else {
                            Label("What's it worth?", systemImage: "sparkles")
                                .frame(maxWidth: .infinity)
                        }
                    }
                    // US-690: brand primary CTA.
                    .buttonStyle(.brandPrimary)
                    .disabled(!store.canEvaluate)

                    if let message = store.errorMessage {
                        errorCard(message)
                    }

                    if let result = store.result {
                        resultCard(result)
                    }
                }
                .padding()
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("What's it worth?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .fullScreenCover(isPresented: $showCamera) {
                CameraPicker { img in store.setImage(img) }
                    .ignoresSafeArea()
            }
            .sheet(item: $sheet) { presented in
                switch presented {
                case .library:
                    PhotoLibraryPicker(selectionLimit: 1) { results in
                        sheet = nil
                        guard let first = results.first else { return }
                        Task {
                            if let img = await first.loadImage() {
                                await MainActor.run { store.setImage(img) }
                            } else {
                                // US-1181: don't silently swallow a failed load.
                                await MainActor.run {
                                    loadError = "Couldn't load that photo — it may still be downloading from iCloud. Try again or pick another."
                                }
                            }
                        }
                    }
                    .ignoresSafeArea()
                case .paywall:
                    if let userId = currentUserId {
                        NavigationStack { PaywallView(userId: userId) }
                    }
                }
            }
            .alert("Camera access is off", isPresented: $showCameraDeniedAlert) {
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Allow camera access in Settings to take a photo, or choose one from your library instead.")
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

    // MARK: - Sections

    @ViewBuilder private var photoArea: some View {
        if let image = store.image {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(maxHeight: 280)
                .frame(maxWidth: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
        } else {
            RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous)
                .fill(Color.secondary.opacity(0.1))
                .frame(height: 220)
                .overlay {
                    VStack(spacing: 8) {
                        Image(systemName: "camera.viewfinder").font(.system(size: 34))
                        Text("Take or choose a photo").font(.subheadline)
                    }
                    .foregroundStyle(.secondary)
                }
        }
    }

    private var captureButtons: some View {
        HStack(spacing: 10) {
            if cameraAvailable {
                Button {
                    AppRouter.haptic()
                    presentCamera()
                } label: {
                    Label("Take photo", systemImage: "camera.fill").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
            Button {
                AppRouter.haptic()
                sheet = .library
            } label: {
                Label("Library", systemImage: "photo.on.rectangle").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
        }
        .tint(Color.brandNavy)
    }

    private var hintFields: some View {
        // US-1180: @Bindable yields two-way bindings from the @Observable store.
        @Bindable var store = store
        return VStack(alignment: .leading, spacing: 8) {
            TextField("Brand (optional — unlocks value)", text: $store.brand)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
            TextField("Item, e.g. Better Sweater (optional)", text: $store.keyword)
                .textFieldStyle(.roundedBorder)
        }
    }

    /// US-1116: a dedicated, obvious error+retry state. The picked photo and
    /// hint fields stay visible above so the user can retry in place (the most
    /// common failure here is a transient network blip on the valuation call).
    ///
    /// US-2152: when the failure is a plan wall (the monthly free-Snap cap), the
    /// recovery is to upgrade, not to retry — retrying just re-hits the cap. The
    /// "Try again" button is replaced with "Upgrade", which opens the paywall.
    /// The upgrade route falls back to "Try again" only if there's no signed-in
    /// user to bill (the paywall needs a user id).
    private func errorCard(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label {
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Color.brandRed)
            }
            if store.isUpgradePrompt, currentUserId != nil {
                Button {
                    AppRouter.haptic()
                    sheet = .paywall
                } label: {
                    Label("Upgrade", systemImage: "sparkles")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.brandPrimary)
            } else {
                Button {
                    AppRouter.haptic()
                    Task { await store.evaluate() }
                } label: {
                    if store.isLoading {
                        ProgressView().frame(maxWidth: .infinity)
                    } else {
                        Label("Try again", systemImage: "arrow.clockwise")
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.brandSecondary)
                .disabled(!store.canEvaluate)
            }
        }
        .padding()
        .background(Color.brandRed.opacity(0.08), in: RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
    }

    private func resultCard(_ result: SnapResponse) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(String(format: "%.1f", result.grade.overallScore))
                        .font(.brandScore(40))
                        .foregroundStyle(GradeScale.color(for: result.grade.overallScore))
                    Text("\(result.grade.gradeTier.capitalized) · \(Int((result.grade.confidence * 100).rounded()))% confidence")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(valueText(result.value))
                        .font(.brandTitle2)
                    Text(valueSubtitle(result.value))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                }
            }

            Text(result.disclaimer)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.brandAmber.opacity(0.12), in: RoundedRectangle(cornerRadius: CornerRadius.chip))

            HStack(spacing: 10) {
                Button {
                    AppRouter.haptic()
                    dismiss()
                    router.showingAddSheet = true
                } label: {
                    Label("Get certified grade", systemImage: "checkmark.seal.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.brandPrimary)  // US-690

                Button {
                    AppRouter.haptic()
                    dismiss()
                    router.selection = .inventory
                } label: {
                    Label("List it", systemImage: "shippingbox").frame(maxWidth: .infinity)
                }
                .buttonStyle(.brandSecondary)  // US-690
            }
        }
        .padding()
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: CornerRadius.control))
    }

    // MARK: - Helpers

    /// US-1181: only the photo-intake/barcode flows handled denied camera access;
    /// Snap checked hardware availability but not authorization, so a user who
    /// previously denied got the system picker's blank/denial UI with no in-app
    /// path to Settings. Gate on the auth status and route denied → Settings.
    private func presentCamera() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            showCamera = true
        case .notDetermined:
            // The image picker will trigger the system prompt itself.
            showCamera = true
        case .denied, .restricted:
            showCameraDeniedAlert = true
        @unknown default:
            showCamera = true
        }
    }

    // US-653: grade→color now flows through the canonical GradeScale.color(for:)
    // brand mapping rather than a local green/orange/red map.

    private func dollars(_ cents: Int?) -> String {
        guard let cents else { return "—" }
        // US-1161: full cents + locale currency, not integer-truncated "$".
        return CurrencyFormatter.shared.formatDisplay(Double(cents) / 100)
    }

    private func valueText(_ value: SnapValue?) -> String {
        guard let value, value.sufficient, value.medianCents != nil else { return "—" }
        return "\(dollars(value.lowCents))–\(dollars(value.highCents))"
    }

    private func valueSubtitle(_ value: SnapValue?) -> String {
        if let value, value.sufficient {
            return "est. resale value\nat this condition"
        }
        if store.brand.isEmpty && store.keyword.isEmpty {
            return "add a brand/item\nto see value"
        }
        return "not enough comps\nto value yet"
    }
}
