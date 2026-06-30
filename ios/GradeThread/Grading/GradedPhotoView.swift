import Photos
import SwiftUI
import UIKit  // UIApplication.openSettingsURLString (US-1408)

/// US-768: the iOS "graded photo" surface — preview the certified Digital Slab
/// (US-763), pick a marketplace format (US-764), then save it to Photos or hand
/// it to the native share sheet. Mirrors the web seller flow (`GradedPhotoPanel`,
/// US-765) and reuses the same `/slab/cert/:id` endpoint via ``SlabImageURL``.
///
/// The slab is server-rendered, so iOS just fetches an image and presents
/// save/share — no client-side compositing.
struct GradedPhotoView: View {
    /// The item's public certificate URL (`<site>/cert/<id>`). The slab URL is
    /// derived from it per format.
    let certificateURL: String

    @Environment(\.dismiss) private var dismiss
    @State private var format: SlabFormat = .square
    @State private var phase: LoadPhase = .loading
    @State private var saveState: SaveState = .idle
    // US-1408: when the save failed specifically because Photos access is off,
    // offer a one-tap deep link to Settings (matching the rest of the app's
    // permission surfaces) instead of just telling the user to go there.
    @State private var photosAccessDenied = false
    // US-1294: certificate-integrity verdict, resolved against the public
    // /verify endpoint before the slab is presented. A tampered/unavailable
    // certificate stays a visible non-pass state (never a silent pass).
    @State private var verification: CertVerification = .verifying
    // US-1165: decode the slab image once when it loads instead of re-running
    // UIImage(data:) in a computed property on every render (scroll / format swap).
    @State private var decodedImage: UIImage?

    enum LoadPhase: Equatable {
        case loading
        case loaded(Data)
        case failed
    }

    enum SaveState: Equatable {
        case idle, saving, saved, failed(String)
    }

    private var slabURL: URL? {
        SlabImageURL.url(certificateURL: certificateURL, format: format)
    }

    private var loadedImage: UIImage? { decodedImage }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.lg) {
                    CertIntegrityBadge(verification: verification) {
                        Task { await verifyCertificate() }
                    }
                    formatPicker
                    preview
                    actions
                    Text("Add your official grade to any listing — buyers scan the code to verify.")
                        .font(.brandCaption)
                        .foregroundStyle(.secondary)
                }
                .padding(Spacing.md)
            }
            .navigationTitle("Graded photo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            // Reload the slab whenever the format changes.
            .task(id: format) { await loadSlab() }
            // US-1294: verify integrity once, in parallel with the slab load,
            // as soon as the sheet appears.
            .task { await verifyCertificate() }
        }
    }

    // MARK: - Format picker

    private var formatPicker: some View {
        Picker("Format", selection: $format) {
            ForEach(SlabFormat.allCases) { f in
                Text(f.label).tag(f)
            }
        }
        .pickerStyle(.segmented)
        .accessibilityLabel("Graded photo format")
    }

    // MARK: - Preview

    private var preview: some View {
        ZStack {
            RoundedRectangle(cornerRadius: CornerRadius.card, style: .continuous)
                .fill(Color(uiColor: .secondarySystemBackground))
            switch phase {
            case .loading:
                ProgressView()
            case .loaded:
                if let image = loadedImage {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .clipShape(RoundedRectangle(cornerRadius: CornerRadius.card, style: .continuous))
                } else {
                    previewFallback
                }
            case .failed:
                previewFallback
            }
        }
        .aspectRatio(format.aspectRatio, contentMode: .fit)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Graded photo preview, \(format.label) format")
    }

    private var previewFallback: some View {
        VStack(spacing: Spacing.xs) {
            Image(systemName: "photo")
                .font(.title2)
                .foregroundStyle(.secondary)
            Text("Couldn't load the preview. Tap Retry to try again.")
                .font(.brandCaption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Retry") { Task { await loadSlab() } }
                .font(.brandCaption.weight(.semibold))
        }
        .padding(Spacing.md)
    }

    // MARK: - Actions

    private var actions: some View {
        VStack(spacing: Spacing.sm) {
            Button {
                AppRouter.haptic()
                saveToPhotos()
            } label: {
                Label(saveButtonTitle, systemImage: saveState == .saved ? "checkmark" : "square.and.arrow.down")
            }
            .buttonStyle(.brandPrimary)
            .disabled(loadedImage == nil || saveState == .saving)

            // Native share sheet — shares the rendered slab image once loaded,
            // else the slab URL so sharing still works during a slow load.
            shareButton

            if case let .failed(message) = saveState {
                VStack(spacing: 6) {
                    Text(message)
                        .font(.brandCaption)
                        .foregroundStyle(Color.brandRed)
                    if photosAccessDenied, let url = URL(string: UIApplication.openSettingsURLString) {
                        Link("Open Settings", destination: url)
                            .font(.brandCaption)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var shareButton: some View {
        if let image = loadedImage {
            ShareLink(
                item: Image(uiImage: image),
                preview: SharePreview("Graded photo", image: Image(uiImage: image))
            ) {
                Label("Share", systemImage: "square.and.arrow.up")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.brandSecondary)
        } else if let slabURL {
            ShareLink(item: slabURL) {
                Label("Share", systemImage: "square.and.arrow.up")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.brandSecondary)
        }
    }

    private var saveButtonTitle: String {
        switch saveState {
        case .saving: return "Saving…"
        case .saved:  return "Saved to Photos"
        default:      return "Save to Photos"
        }
    }

    // MARK: - Load + save

    private func loadSlab() async {
        guard let slabURL else { phase = .failed; decodedImage = nil; return }
        phase = .loading
        decodedImage = nil
        // Reset the save affordance for the newly-selected format.
        saveState = .idle
        do {
            // Bounded session (20s) so a stalled slab fetch fails fast to the
            // `.failed`/retry state instead of spinning ~60s (URLSession.shared).
            let (data, response) = try await EdgeNetwork.shared.data(from: slabURL)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let image = UIImage(data: data) else {
                phase = .failed
                return
            }
            decodedImage = image // US-1165: decode once, reused by preview/save/share
            phase = .loaded(data)
        } catch {
            phase = .failed
        }
    }

    /// US-1294: resolve the certificate-integrity verdict from the public
    /// /verify endpoint. Never throws — a failure surfaces as `.unavailable`.
    private func verifyCertificate() async {
        verification = .verifying
        verification = await CertIntegrityService.verify(certificateURL: certificateURL)
    }

    private func saveToPhotos() {
        guard let image = loadedImage else { return }
        saveState = .saving
        photosAccessDenied = false
        // Add-only authorization — we never read the user's library here.
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                Task { @MainActor in
                    photosAccessDenied = true
                    saveState = .failed("Photos access is off. Enable it in Settings to save.")
                    HapticFeedback.error()
                }
                return
            }
            PHPhotoLibrary.shared().performChanges {
                PHAssetCreationRequest.creationRequestForAsset(from: image)
            } completionHandler: { success, error in
                Task { @MainActor in
                    if success {
                        saveState = .saved
                        HapticFeedback.success()
                        A11yAnnounce.announce("Graded photo saved to Photos.")
                        Telemetry.event("graded_photo_saved", props: ["format": format.rawValue])
                    } else {
                        saveState = .failed(error?.localizedDescription ?? "Couldn't save the photo.")
                        HapticFeedback.error()
                    }
                }
            }
        }
    }
}
