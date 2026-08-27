import Photos
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import UIKit

/// SwiftUI host for `PHPickerViewController`. Multi-select up to
/// `selectionLimit`, images only.
///
/// We configure it with a bare `PHPickerConfiguration()` — NO
/// `photoLibrary:` argument (US-1013). That keeps the picker fully
/// out-of-process: it requires no photo-library permission, never shows
/// the "Allow access to all photos?" prompt, and hands back only the
/// explicitly-selected images. The tradeoff is that results carry no
/// `assetIdentifier`, so we can't read PHAsset metadata (capture date) —
/// callers fall back to `.now`. Not escalating to full-library access just
/// to pick a few photos is the deliberate privacy win here.
struct PhotoLibraryPicker: UIViewControllerRepresentable {
    /// Max number of images the user can pick in one pass. `0` means
    /// unlimited; we cap at 8 per the AC to keep the staging tray
    /// reviewable in one screen.
    let selectionLimit: Int

    /// Delivered when the user finishes or cancels. An empty array means
    /// "cancel".
    let onResults: ([PHPickerResult]) -> Void

    /// US-2926: SwiftUI dismisses this, NOT UIKit.
    ///
    /// The coordinator used to call `picker.dismiss(animated: true)` itself.
    /// That tears the controller down imperatively, behind the back of the
    /// `.sheet` binding that presented it, so SwiftUI still believes its sheet
    /// is up. The next presentation change on that view then acts on a stale
    /// belief and dismisses the wrong thing — which, for a picker opened from
    /// inside Snap-to-Value or Prospect (both themselves sheets), was the
    /// module, on the next state change after the pick. That state change is
    /// the submit button setting `isLoading`, which is why it read as "it
    /// closes when I hit submit" and why nothing ever reached the server.
    ///
    /// ``CameraPicker`` has always done it this way and has never had the bug:
    /// a photo taken with the camera submits fine, and the same item picked
    /// from the library does not. That asymmetry is the whole diagnosis.
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> PHPickerViewController {
        // Bare config (no `photoLibrary:`) → no library permission, no prompt.
        var config = PHPickerConfiguration()
        config.selectionLimit = selectionLimit
        config.filter = .images
        // Skip the slow PHAsset → JPEG transcoding step — we already
        // re-compress in PhotoCompressor.
        config.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: PHPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onResults: onResults, dismiss: { dismiss() })
    }

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let onResults: ([PHPickerResult]) -> Void
        let dismiss: () -> Void

        init(
            onResults: @escaping ([PHPickerResult]) -> Void,
            dismiss: @escaping () -> Void
        ) {
            self.onResults = onResults
            self.dismiss = dismiss
        }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            // Results first, then dismiss — the order ``CameraPicker`` uses.
            // Several callers clear their own binding inside `onResults`; that
            // is harmless, because the dismiss below then finds nothing left to
            // do. Six others do NOT, which is why the dismissal has to live
            // here rather than being pushed out to eleven call sites.
            onResults(results)
            dismiss()
        }
    }
}

// MARK: - PHPickerResult loading helper

extension PHPickerResult {
    /// Loads the picked asset as a `UIImage`. Returns nil for picks that
    /// don't represent loadable images — e.g. an asset that's still being
    /// downloaded from iCloud or that the provider can't materialize for
    /// some reason. Caller surfaces the count gap to the user.
    func loadImage() async -> UIImage? {
        guard itemProvider.canLoadObject(ofClass: UIImage.self) else { return nil }
        return await withCheckedContinuation { (cont: CheckedContinuation<UIImage?, Never>) in
            itemProvider.loadObject(ofClass: UIImage.self) { object, _ in
                cont.resume(returning: object as? UIImage)
            }
        }
    }

    /// Loads the pick as an image AND its original capture time (US-2373).
    ///
    /// Goes through the file's raw bytes rather than `loadObject(ofClass:)` so
    /// the EXIF block is still intact when we read the shutter time from it —
    /// `UIImage` drops that metadata, which is why the AutoLister batch used to
    /// arrive with no capture times at all. Falls back to the plain image load
    /// (and the PHAsset lookup, which is almost always nil by design) when the
    /// provider can't hand over a data representation.
    func loadImageWithCaptureDate() async -> (image: UIImage, capturedAt: Date?)? {
        if let data = await loadImageData(), let image = UIImage(data: data) {
            return (image, ImageCaptureDate.from(data) ?? creationDate())
        }
        guard let image = await loadImage() else { return nil }
        return (image, creationDate())
    }

    /// The pick's bytes in whatever representation it already has on disk (the
    /// picker is configured `.current`, so this doesn't trigger a transcode).
    private func loadImageData() async -> Data? {
        let provider = itemProvider
        let identifier = provider.registeredTypeIdentifiers
            .first { UTType($0)?.conforms(to: .image) == true }
        guard let identifier else { return nil }
        return await withCheckedContinuation { (cont: CheckedContinuation<Data?, Never>) in
            provider.loadDataRepresentation(forTypeIdentifier: identifier) { data, _ in
                cont.resume(returning: data)
            }
        }
    }

    /// The picked asset's ORIGINAL capture time (US-289), read from `PHAsset`
    /// BEFORE PhotoCompressor strips EXIF. Strictly best-effort and, by design
    /// (US-1013), almost always nil: it needs both an `assetIdentifier` (only
    /// present when the picker is configured with a shared `photoLibrary`,
    /// which we deliberately don't do) AND already-granted library read access.
    /// We never request that access here, so a capture-date lookup can never be
    /// the thing that triggers a permission prompt or reads the library without
    /// consent. When it returns nil the caller falls back to `.now`.
    func creationDate() -> Date? {
        guard let id = assetIdentifier else { return nil }
        // Only touch PHAsset if the user has ALREADY authorized full library
        // reads. `.limited` is excluded on purpose — the picked asset may sit
        // outside the limited selection, and probing could surface a prompt.
        guard PHPhotoLibrary.authorizationStatus(for: .readWrite) == .authorized else { return nil }
        let assets = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil)
        return assets.firstObject?.creationDate
    }
}
