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

    private func loadAttachmentsAndPresent() {
        guard let extensionContext else {
            complete()
            return
        }
        let items = extensionContext.inputItems.compactMap { $0 as? NSExtensionItem }
        let imageType = UTType.image.identifier

        Task {
            var images: [UIImage] = []
            for item in items {
                guard let attachments = item.attachments else { continue }
                for provider in attachments where provider.hasItemConformingToTypeIdentifier(imageType) {
                    if let image = await loadImage(from: provider) {
                        images.append(image)
                    }
                }
            }
            await MainActor.run {
                self.present(images: images)
            }
        }
    }

    private func loadImage(from provider: NSItemProvider) async -> UIImage? {
        await withCheckedContinuation { (cont: CheckedContinuation<UIImage?, Never>) in
            provider.loadItem(forTypeIdentifier: UTType.image.identifier, options: nil) { item, _ in
                if let image = item as? UIImage {
                    cont.resume(returning: image)
                } else if let url = item as? URL, let data = try? Data(contentsOf: url),
                          let image = UIImage(data: data) {
                    cont.resume(returning: image)
                } else if let data = item as? Data, let image = UIImage(data: data) {
                    cont.resume(returning: image)
                } else {
                    cont.resume(returning: nil)
                }
            }
        }
    }

    @MainActor
    private func present(images: [UIImage]) {
        let host = UIHostingController(
            rootView: ShareIntakeView(
                images: images,
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

    private func handleSubmit(assignments: [(slot: String, image: UIImage)]) {
        Task.detached(priority: .userInitiated) {
            let payload: [(slot: String, jpegData: Data)] = assignments.compactMap { entry in
                guard let data = entry.image.jpegData(compressionQuality: 0.8) else { return nil }
                return (slot: entry.slot, jpegData: data)
            }
            _ = try? IntakeInbox.writeBatch(photos: payload)
            await MainActor.run {
                self.complete()
            }
        }
    }

    private func complete() {
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }
}
