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
    /// Photo ids whose download/composite failed — drives a per-row retry in the
    /// view instead of an indefinite spinner (a stalled/failed photo fetch
    /// previously left that row spinning forever with its Save button disabled).
    var renderFailed: Set<String> = []
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
    func didRenderFail(_ photo: DisclosurePhoto) -> Bool { renderFailed.contains(photo.id) }

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
            await renderOne(photo)
        }
    }

    /// Download + composite a single photo, recording a failure (for the per-row
    /// retry) instead of leaving the row spinning. Public entry is ``retryRender``.
    private func renderOne(_ photo: DisclosurePhoto) async {
        renderFailed.remove(photo.id)
        guard let image = await downloadImage(photo.url) else {
            renderFailed.insert(photo.id)
            return
        }
        // US-1165: the composite is a full-res UIGraphicsImageRenderer draw — run
        // it off the main actor (mirrors PhotoCompressor.compressOffMain) and hop
        // back to store it.
        let annotations = photo.annotations
        let composite = await Task.detached(priority: .userInitiated) {
            DisclosureRenderer.render(image: image, annotations: annotations)
        }.value
        rendered[photo.id] = composite
    }

    /// Retry a single failed photo render (download + composite) from the view.
    func retryRender(_ photo: DisclosurePhoto) async {
        await renderOne(photo)
    }

    /// Save the composited image to the item's listing photos (server uploads +
    /// inserts the row). Triggers a sync pull so the new photo lands locally.
    @discardableResult
    func save(_ photo: DisclosurePhoto) async -> Bool {
        guard let image = rendered[photo.id] else { return false }
        // US-1165: PNG-encode + base64 off the main actor before the upload.
        let dataURL = await Task.detached(priority: .userInitiated) {
            DisclosureRenderer.dataURL(for: image)
        }.value
        guard let dataURL else { return false }
        // US-1225: clear the banner so a successful retry doesn't stay pinned
        // behind a stale error (previously only load() cleared it).
        errorMessage = nil
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
            return res.ok
        } catch {
            errorMessage = message(error)
            return false
        }
    }

    /// Append the disclosure text to the eBay listing description.
    @discardableResult
    func applyText() async -> Bool {
        // US-1225: clear the banner so a successful retry doesn't stay pinned
        // behind a stale error (previously only load() cleared it).
        errorMessage = nil
        isApplyingText = true
        defer { isApplyingText = false }
        do {
            let res = try await service.applyToListing(itemId: itemId)
            appliedText = res.applied || (res.alreadyPresent ?? false)
            return appliedText
        } catch {
            errorMessage = message(error)
            return false
        }
    }

    // MARK: - Helpers

    private func downloadImage(_ urlString: String) async -> UIImage? {
        guard let url = URL(string: urlString) else { return nil }
        do {
            // Bounded session (20s) so a stalled defect-photo fetch fails fast to
            // the per-row retry instead of spinning ~60s (URLSession.shared).
            let (bytes, _) = try await EdgeNetwork.shared.data(from: url)
            return UIImage(data: bytes)
        } catch {
            return nil
        }
    }

    private func message(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
