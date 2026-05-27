import SafariServices
import SwiftUI

/// Lightweight SwiftUI wrapper around `SFSafariViewController` for in-app
/// web flows that don't warrant a full browser bounce — the reset-password
/// page being the canonical case.
struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let config = SFSafariViewController.Configuration()
        config.entersReaderIfAvailable = false
        let controller = SFSafariViewController(url: url, configuration: config)
        controller.preferredControlTintColor = UIColor(Color.brandNavy)
        controller.dismissButtonStyle = .done
        return controller
    }

    func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) {}
}
