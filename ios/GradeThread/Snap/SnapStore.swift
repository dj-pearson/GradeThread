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

    // Default is constructed in the init BODY (main-actor-isolated, since this
    // type is @MainActor) rather than as a default argument — a default argument
    // is evaluated in a nonisolated context and can't call SnapService's
    // @MainActor init.
    init(service: SnapService? = nil) {
        self.service = service ?? SnapService()
    }

    func setImage(_ img: UIImage) {
        image = img
        result = nil
        errorMessage = nil
    }

    var canEvaluate: Bool { image != nil && !isLoading }

    func evaluate() async {
        guard let img = image else {
            errorMessage = "Couldn't read that photo. Try another."
            return
        }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        // US-636: compress off the main actor so the spinner stays smooth.
        guard let output = await PhotoCompressor.compressOffMain(img) else {
            errorMessage = "Couldn't read that photo. Try another."
            return
        }
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
