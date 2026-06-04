import SwiftUI

/// View-model for Snap-to-Value (US-613). Holds the picked photo + optional
/// brand/item hint, calls ``SnapService``, and exposes the result/error for the
/// view. Compresses the image (and strips EXIF) before upload via
/// ``PhotoCompressor`` — the same path the capture flow uses.
@MainActor
final class SnapStore: ObservableObject {

    @Published var image: UIImage?
    @Published var brand: String = ""
    @Published var keyword: String = ""
    @Published var isLoading = false
    @Published var result: SnapResponse?
    @Published var errorMessage: String?

    private let service: SnapService

    init(service: SnapService = SnapService()) {
        self.service = service
    }

    func setImage(_ img: UIImage) {
        image = img
        result = nil
        errorMessage = nil
    }

    var canEvaluate: Bool { image != nil && !isLoading }

    func evaluate() async {
        guard let img = image, let output = PhotoCompressor.compress(img) else {
            errorMessage = "Couldn't read that photo. Try another."
            return
        }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            result = try await service.snap(
                imageData: output.imageData,
                brand: brand.trimmingCharacters(in: .whitespacesAndNewlines),
                keyword: keyword.trimmingCharacters(in: .whitespacesAndNewlines)
            )
        } catch {
            result = nil
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}
