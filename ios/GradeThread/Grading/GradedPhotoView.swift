import Photos
import SwiftUI
import UIKit

/// US-768: the iOS "graded photo" — a preview + save/share surface for the
/// server-rendered Digital Slab (US-763/764). Loads the certified image
/// (`/slab/cert/:id?format=…`) for the chosen marketplace format, then lets the
/// seller save it to Photos or share it via the native sheet. Mirrors the web
/// `GradedPhotoPanel` (US-765) and reuses the same slab endpoint.
struct GradedPhotoView: View {
    let certificateId: String

    @Environment(\.dismiss) private var dismiss

    @State private var format: SlabFormat = .square
    @State private var image: UIImage?
    @State private var phase: Phase = .loading
    @State private var statusMessage: String?

    private enum Phase: Equatable {
        case loading
        case loaded
        case failed
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    formatPicker
                    preview
                    actions
                    Text("Add your official grade to any listing — buyers scan the code to verify.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    if let statusMessage {
                        Text(statusMessage)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .transition(.opacity)
                    }
                }
                .padding()
            }
            .navigationTitle("Graded photo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            // Reloads on appear and whenever the format changes.
            .task(id: format) { await loadImage() }
        }
    }

    // MARK: - Sections

    private var formatPicker: some View {
        Picker("Format", selection: $format) {
            ForEach(SlabFormat.allCases) { fmt in
                Text(fmt.title).tag(fmt)
            }
        }
        .pickerStyle(.segmented)
    }

    @ViewBuilder
    private var preview: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color(.secondarySystemBackground))
            switch phase {
            case .loading:
                ProgressView()
            case .loaded:
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .accessibilityLabel("Graded photo preview")
                }
            case .failed:
                VStack(spacing: 8) {
                    Image(systemName: "photo")
                        .font(.title)
                        .foregroundStyle(.secondary)
                    Text("Couldn't load the graded photo.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Button("Try again") { Task { await loadImage() } }
                        .font(.footnote.weight(.semibold))
                }
                .padding()
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: 360)
    }

    /// The loaded slab as a SwiftUI `Image` for `ShareLink`, when available.
    private var shareImage: Image? { image.map { Image(uiImage: $0) } }

    @ViewBuilder
    private var actions: some View {
        HStack(spacing: 12) {
            Button {
                Task { await saveToPhotos() }
            } label: {
                Label("Save to Photos", systemImage: "square.and.arrow.down")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(Color.brandNavy)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(image == nil)

            if let shareImage {
                ShareLink(
                    item: shareImage,
                    preview: SharePreview("GradeThread graded photo", image: shareImage)
                ) {
                    Label("Share", systemImage: "square.and.arrow.up")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .overlay(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .stroke(Color.brandNavy, lineWidth: 1)
                        )
                        .foregroundStyle(Color.brandNavy)
                }
            } else {
                Label("Share", systemImage: "square.and.arrow.up")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Data

    private func slabURL() -> URL? {
        guard
            var components = URLComponents(
                string: "\(CertificateLink.siteOrigin.absoluteString)/slab/cert/\(certificateId)"
            )
        else { return nil }
        components.queryItems = [URLQueryItem(name: "format", value: format.rawValue)]
        return components.url
    }

    private func loadImage() async {
        phase = .loading
        statusMessage = nil
        guard let url = slabURL() else {
            phase = .failed
            return
        }
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard
                let http = response as? HTTPURLResponse,
                http.statusCode == 200,
                let decoded = UIImage(data: data)
            else {
                phase = .failed
                return
            }
            image = decoded
            phase = .loaded
        } catch {
            phase = .failed
        }
    }

    private func saveToPhotos() async {
        guard let image else { return }
        // Add-only authorization — we never read the library here.
        let status = await withCheckedContinuation { (continuation: CheckedContinuation<PHAuthorizationStatus, Never>) in
            PHPhotoLibrary.requestAuthorization(for: .addOnly) { continuation.resume(returning: $0) }
        }
        guard status == .authorized || status == .limited else {
            withAnimation { statusMessage = "Allow photo access in Settings to save." }
            return
        }
        do {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                PHPhotoLibrary.shared().performChanges {
                    PHAssetChangeRequest.creationRequestForAsset(from: image)
                } completionHandler: { success, error in
                    if success {
                        continuation.resume()
                    } else {
                        continuation.resume(throwing: error ?? GradedPhotoError.saveFailed)
                    }
                }
            }
            AppRouter.haptic()
            withAnimation { statusMessage = "Saved to Photos." }
        } catch {
            withAnimation { statusMessage = "Couldn't save the image." }
        }
    }
}

private enum GradedPhotoError: Error {
    case saveFailed
}

/// Marketplace-specific slab aspect ratios (mirrors the web `?format=` values).
private enum SlabFormat: String, CaseIterable, Identifiable {
    case square
    case portrait
    case story
    case label

    var id: String { rawValue }

    var title: String {
        switch self {
        case .square: return "Square"
        case .portrait: return "Portrait"
        case .story: return "Story"
        case .label: return "Label"
        }
    }
}
