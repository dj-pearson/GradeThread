import PhotosUI
import SwiftUI
import UIKit

/// SwiftUI host for `PHPickerViewController`. Multi-select up to
/// `selectionLimit`, images only.
///
/// PHPicker is the right pick (vs. the deprecated UIImagePickerController)
/// because it does not require photo-library permission — the picker runs
/// in a separate process and only the explicitly-selected images are
/// handed back to us. No "Allow access to all photos?" prompt.
struct PhotoLibraryPicker: UIViewControllerRepresentable {
    /// Max number of images the user can pick in one pass. `0` means
    /// unlimited; we cap at 8 per the AC to keep the staging tray
    /// reviewable in one screen.
    let selectionLimit: Int

    /// Delivered when the user finishes or cancels. An empty array means
    /// "cancel".
    let onResults: ([PHPickerResult]) -> Void

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var config = PHPickerConfiguration(photoLibrary: .shared())
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
}
