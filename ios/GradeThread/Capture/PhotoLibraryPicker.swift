import Photos
import PhotosUI
import SwiftUI
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

    func makeCoordinator() -> Coordinator { Coordinator(onResults: onResults) }

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let onResults: ([PHPickerResult]) -> Void

        init(onResults: @escaping ([PHPickerResult]) -> Void) {
            self.onResults = onResults
        }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            picker.dismiss(animated: true)
            onResults(results)
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
