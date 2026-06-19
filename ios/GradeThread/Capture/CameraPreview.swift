import AVFoundation
import SwiftUI
import UIKit

/// SwiftUI host for an `AVCaptureVideoPreviewLayer`. The layer is owned by
/// a thin UIView subclass so AutoLayout sizes it correctly without manual
/// frame management — `previewLayer.videoGravity = .resizeAspectFill` then
/// fills whatever container SwiftUI puts the preview in.
struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> PreviewContainerView {
        let view = PreviewContainerView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        return view
    }

    func updateUIView(_ uiView: PreviewContainerView, context: Context) {
        // Reassigning the session is cheap when it's already the same
        // reference; covers the (rare) case where the camera is hot-swapped
        // — useful once US-174's library flow can interleave.
        if uiView.previewLayer.session !== session {
            uiView.previewLayer.session = session
        }
    }

    /// UIView subclass whose backing CALayer *is* the preview layer.
    /// Cheaper than embedding a sublayer because the layer is the root
    /// CALayer of the view — no manual frame tracking.
    final class PreviewContainerView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }

        /// Built only if the `layerClass` override somehow fails to take effect —
        /// degrade gracefully instead of trapping on a force-cast. In a shipped
        /// build the cast below always succeeds, so this stays nil.
        private var fallbackPreviewLayer: AVCaptureVideoPreviewLayer?

        var previewLayer: AVCaptureVideoPreviewLayer {
            if let previewLayer = layer as? AVCaptureVideoPreviewLayer {
                return previewLayer
            }
            if let fallback = fallbackPreviewLayer { return fallback }
            let fallback = AVCaptureVideoPreviewLayer()
            fallback.frame = bounds
            layer.addSublayer(fallback)
            fallbackPreviewLayer = fallback
            return fallback
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            fallbackPreviewLayer?.frame = bounds
        }
    }
}
