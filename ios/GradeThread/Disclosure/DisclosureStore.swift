import SwiftUI
import UIKit

/// View-model for the Defect Disclosure screen. Loads the item's disclosure
/// data, downloads + composites each defect photo into an annotated image, and
/// drives saving an annotated image to the listing photos / appending the
/// disclosure text to the listing. Pattern mirrors `SpecificsEditorModel`
/// (@MainActor @Observable).
@MainActor
@Observable
final class DisclosureStore {

    enum Phase: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    let itemId: String
    private let service: DisclosureProviding

    var phase: Phase = .idle
    var data: DisclosureData?
    /// Composited annotated images keyed by `DisclosurePhoto.id`.
    var rendered: [String: UIImage] = [:]
    var savedPhotoIds: Set<String> = []
    var isApplyingText = false
    var appliedText = false
    var errorMessage: String?

    private var savingPhotoIds: Set<String> = []

    init(itemId: String, service: DisclosureProviding = DisclosureService()) {
        self.itemId = itemId
        self.service = service
    }

    // MARK: - Derived

    /// Photos that actually carry callouts (others have nothing to disclose).
    var defectPhotos: [DisclosurePhoto] {
        (data?.photos ?? []).filter { !$0.annotations.isEmpty }
    }

    var plainDisclosure: String? {
        let p = data?.disclosure?.plain
        return (p?.isEmpty == false) ? p : nil
    }

    func isSaving(_ photo: DisclosurePhoto) -> Bool { savingPhotoIds.contains(photo.id) }
    func isSaved(_ photo: DisclosurePhoto) -> Bool { savedPhotoIds.contains(photo.id) }

    // MARK: - Lifecycle

    func load() async {
        phase = .loading
        errorMessage = nil
        do {
            data = try await service.disclosure(itemId: itemId)
            phase = .loaded
            await renderAll()
        } catch {
            phase = .failed(message(error))
        }
    }

    /// Download + composite each defect photo (skips ones already rendered).
    private func renderAll() async {
        for photo in defectPhotos where rendered[photo.id] == nil {
            if let image = await downloadImage(photo.url) {
                rendered[photo.id] = DisclosureRenderer.render(image: image, annotations: photo.annotations)
            }
        }
    }

    /// Save the composited image to the item's listing photos (server uploads +
    /// inserts the row). Triggers a sync pull so the new photo lands locally.
    func save(_ photo: DisclosurePhoto) async {
        guard let image = rendered[photo.id],
              let dataURL = DisclosureRenderer.dataURL(for: image) else { return }
        savingPhotoIds.insert(photo.id)
        defer { savingPhotoIds.remove(photo.id) }
        do {
            let res = try await service.saveAnnotated(
                itemId: itemId, imageType: photo.imageType, dataURL: dataURL
            )
            if res.ok {
                savedPhotoIds.insert(photo.id)
                NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
            }
        } catch {
            errorMessage = message(error)
        }
    }

    /// Append the disclosure text to the eBay listing description.
    func applyText() async {
        isApplyingText = true
        defer { isApplyingText = false }
        do {
            let res = try await service.applyToListing(itemId: itemId)
            appliedText = res.applied || (res.alreadyPresent ?? false)
        } catch {
            errorMessage = message(error)
        }
    }

    // MARK: - Helpers

    private func downloadImage(_ urlString: String) async -> UIImage? {
        guard let url = URL(string: urlString) else { return nil }
        do {
            let (bytes, _) = try await URLSession.shared.data(from: url)
            return UIImage(data: bytes)
        } catch {
            return nil
        }
    }

    private func message(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
