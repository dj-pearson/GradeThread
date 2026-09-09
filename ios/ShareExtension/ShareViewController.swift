import ImageIO
import Social
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Principal class for the Share Extension. Loads the image attachments
/// from the shared content, hands them to ``ShareIntakeView`` for slot
/// assignment, then writes them to the App Group inbox so the main app
/// can resume on next launch.
final class ShareViewController: UIViewController {

    override func viewDidLoad() {
        super.viewDidLoad()
        loadAttachmentsAndPresent()
    }

    /// Long edge, in pixels, a shared photo is decoded at.
    ///
    /// Matches ``downscaledJPEG``'s budget and the main app's PhotoCompressor,
    /// so the submit-time encode re-encodes an already-right-sized image rather
    /// than being the first thing that shrinks anything.
    static let importMaxPixels: CGFloat = 1600

    /// How many photos one share can stage.
    ///
    /// Two reasons, and the second is why the number is this one rather than a
    /// round guess. A share extension gets a fraction of the app's memory
    /// budget, so an unbounded batch is a jetsam with no error message. And the
    /// default-assignment list runs out: `slots[min(idx, count - 1)]` in
    /// ``ShareIntakeView`` pins every photo past the end onto the SAME last
    /// slot, so photo 31 and photo 60 both quietly become "surface".
    static var importLimit: Int { ShareIntakeView.defaultAssignmentSlots.count }

    private func loadAttachmentsAndPresent() {
        guard let extensionContext else {
            complete()
            return
        }
        let items = extensionContext.inputItems.compactMap { $0 as? NSExtensionItem }
        let imageType = UTType.image.identifier

        Task {
            var images: [UIImage] = []
            var dropped = 0
            for item in items {
                guard let attachments = item.attachments else { continue }
                for provider in attachments where provider.hasItemConformingToTypeIdentifier(imageType) {
                    // Counted BEFORE decoding, not after: the point is to never
                    // hold the 31st image, not to hold it and then discard it.
                    guard images.count < Self.importLimit else {
                        dropped += 1
                        continue
                    }
                    if let image = await loadImage(from: provider) {
                        images.append(image)
                    }
                }
            }
            let staged = images
            let overflow = dropped
            await MainActor.run {
                // US-1222: nothing decoded (the share carried no usable image,
                // an iCloud file couldn't be pulled, etc.). Presenting the
                // intake view with zero images strands the user on an empty
                // slot grid. Show a clear message and finish instead.
                guard !staged.isEmpty else {
                    self.presentMessage(
                        title: "No images to import",
                        body: "GradeThread couldn't find any images in what you shared. Try sharing the photos directly from your library."
                    )
                    return
                }
                self.present(images: staged, dropped: overflow)
            }
        }
    }

    private func loadImage(from provider: NSItemProvider) async -> UIImage? {
        // US-1222: prefer loadFileRepresentation for file-backed attachments. It
        // copies the (possibly large or not-yet-downloaded iCloud) item to a
        // local temp URL off the caller's thread and manages the
        // security-scoped resource for us — no synchronous Data(contentsOf:)
        // blocking the provider callback on a multi-megabyte read or a network
        // fetch. We fall back to loadItem only for in-memory UIImage/Data reps.
        let typeIdentifier = UTType.image.identifier

        if provider.hasRepresentationConforming(toTypeIdentifier: typeIdentifier, fileOptions: []) {
            if let image = await loadFileImage(from: provider, typeIdentifier: typeIdentifier) {
                return image
            }
        }

        return await loadInMemoryImage(from: provider, typeIdentifier: typeIdentifier)
    }

    /// File-backed path: `loadFileRepresentation` hands us a temp URL valid only
    /// for the duration of the closure, so we read it inside — but the framework
    /// has already done the heavy copy/download off this thread.
    private func loadFileImage(from provider: NSItemProvider, typeIdentifier: String) async -> UIImage? {
        await withCheckedContinuation { (cont: CheckedContinuation<UIImage?, Never>) in
            provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { url, _ in
                guard let url else {
                    cont.resume(returning: nil)
                    return
                }
                // The provided URL may be a security-scoped resource (shared
                // from another app / iCloud Drive); claim access before reading.
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                cont.resume(returning: Self.downsampledImage(at: url))
            }
        }
    }

    // MARK: - Decoding at import size (not at full resolution)

    /// ⚠ THIS USED TO BE `UIImage(data: try Data(contentsOf: url))`, AND THAT
    /// IS A FULL-RESOLUTION IMAGE.
    ///
    /// `UIImage(data:)` looks cheap because the decode is lazy, but the
    /// intake list draws a thumbnail of every row, and drawing is what forces
    /// the decode. A 12-megapixel photo becomes roughly 48 MB of bitmap that
    /// the `UIImage` then holds for as long as the array does. Scroll a
    /// twenty-photo share to the bottom and the extension has decoded twenty of
    /// them, inside a memory budget far smaller than the app's. There is no
    /// crash report for that: iOS simply kills the extension and the share
    /// vanishes.
    ///
    /// The US-1646 downscale runs at SUBMIT, which is after all of this has
    /// already happened. ImageIO's thumbnail path never materialises the
    /// full-size bitmap at all, so the image lands at import size and the
    /// submit-time encode has nothing left to shrink.
    static func downsampledImage(at url: URL) -> UIImage? {
        let options: [CFString: Any] = [kCGImageSourceShouldCache: false]
        guard let source = CGImageSourceCreateWithURL(url as CFURL, options as CFDictionary)
        else { return nil }
        return downsampled(from: source)
    }

    static func downsampledImage(from data: Data) -> UIImage? {
        let options: [CFString: Any] = [kCGImageSourceShouldCache: false]
        guard let source = CGImageSourceCreateWithData(data as CFData, options as CFDictionary)
        else { return nil }
        return downsampled(from: source)
    }

    private static func downsampled(from source: CGImageSource) -> UIImage? {
        let options: [CFString: Any] = [
            // `...FromImageAlways` rather than `...IfAbsent`: an embedded
            // camera thumbnail is typically 320px, which is not enough for the
            // upload the app then makes from it.
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            // Bakes the EXIF orientation into the bitmap, so a portrait photo
            // arrives upright rather than sideways with a flag on it.
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: Int(importMaxPixels),
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        else { return nil }
        return UIImage(cgImage: cgImage)
    }

    /// In-memory fallback for providers that vend a UIImage or raw Data
    /// directly (e.g. screenshots, pasteboard images) rather than a file.
    private func loadInMemoryImage(from provider: NSItemProvider, typeIdentifier: String) async -> UIImage? {
        await withCheckedContinuation { (cont: CheckedContinuation<UIImage?, Never>) in
            provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { item, _ in
                if let image = item as? UIImage {
                    // Already decoded by whoever vended it, so there is no
                    // thumbnail path to take; shrink it so it does not sit at
                    // full size in the array like the file path used to.
                    cont.resume(returning: Self.resized(image, maxLongEdge: Self.importMaxPixels))
                } else if let data = item as? Data {
                    cont.resume(returning: Self.downsampledImage(from: data))
                } else {
                    cont.resume(returning: nil)
                }
            }
        }
    }

    @MainActor
    private func present(images: [UIImage], dropped: Int = 0) {
        let host = UIHostingController(
            rootView: ShareIntakeView(
                images: images,
                dropped: dropped,
                onSubmit: { [weak self] assignments in
                    self?.handleSubmit(assignments: assignments)
                },
                onCancel: { [weak self] in
                    self?.complete()
                }
            )
        )
        host.modalPresentationStyle = .fullScreen
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }

    /// US-1646: PhotoCompressor-equivalent downscale for the Share extension
    /// (which doesn't link the main app's PhotoCompressor). Resizes to a
    /// `maxLongEdge` long edge (baking orientation upright via the renderer) and
    /// JPEG-encodes at `quality` — ~450–500 KB instead of the raw 3–10 MB.
    private static func downscaledJPEG(
        _ image: UIImage,
        maxLongEdge: CGFloat = ShareViewController.importMaxPixels,
        quality: CGFloat = 0.75
    ) -> Data? {
        resized(image, maxLongEdge: maxLongEdge).jpegData(compressionQuality: quality)
    }

    /// Redraws `image` so its long edge is at most `maxLongEdge`, baking the
    /// orientation upright. Returns the original when it is already small
    /// enough, so the common path (an image that came through
    /// ``downsampledImage(at:)``) costs nothing.
    static func resized(_ image: UIImage, maxLongEdge: CGFloat) -> UIImage {
        let longEdge = max(image.size.width, image.size.height)
        // The orientation check matters as much as the size one: this redraw is
        // also what bakes a sideways camera photo upright, and returning early
        // on a small-but-rotated image would hand the caller back the flag.
        guard longEdge > 0, longEdge > maxLongEdge || image.imageOrientation != .up else {
            return image
        }
        let scale = maxLongEdge / longEdge
        let target = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
    }

    private func handleSubmit(assignments: [(slot: String, image: UIImage)]) {
        Task.detached(priority: .userInitiated) {
            let payload: [(slot: String, jpegData: Data)] = assignments.compactMap { entry in
                // US-1646: downscale share imports in the extension (PhotoCompressor
                // isn't linked here) so they don't stage + upload at full 3–10 MB
                // resolution — which also fixes the P1 full-res-in-memory jetsam.
                // Mirrors PhotoCompressor's 1600px long-edge / 0.75 JPEG budget.
                guard let data = Self.downscaledJPEG(entry.image) else { return nil }
                return (slot: entry.slot, jpegData: data)
            }
            // US-1222: a swallowed `try?` here let a failed App Group write
            // (container unavailable, disk full, encryption error) finish the
            // share silently — the user believes the photos reached FlipDesk
            // when nothing was staged. Surface the failure instead of
            // completing as if it succeeded.
            do {
                try IntakeInbox.writeBatch(photos: payload)
                await MainActor.run {
                    self.complete()
                }
            } catch {
                await MainActor.run {
                    self.presentFailureAlert(message: error.localizedDescription)
                }
            }
        }
    }

    /// Replaces the intake UI with a simple message + Done button. Used both
    /// for the empty-share case and to report a write failure, so the user
    /// always gets an explicit outcome before the extension dismisses.
    @MainActor
    private func presentMessage(title: String, body: String) {
        let alert = UIAlertController(title: title, message: body, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Done", style: .default) { [weak self] _ in
            self?.complete()
        })
        present(alert, animated: true)
    }

    @MainActor
    private func presentFailureAlert(message: String) {
        let alert = UIAlertController(
            title: "Couldn't save to FlipDesk",
            message: "Your photos weren't imported. \(message)",
            preferredStyle: .alert
        )
        // Don't auto-complete the share — leave the user on the intake view so
        // they can retry. Cancel finishes without staging anything.
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        alert.addAction(UIAlertAction(title: "Cancel share", style: .cancel) { [weak self] _ in
            self?.complete()
        })
        present(alert, animated: true)
    }

    private func complete() {
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }
}
