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

        var previewLayer: AVCaptureVideoPreviewLayer {
            // Force-cast safe because of layerClass override above.
            // swiftlint:disable:next force_cast
            layer as! AVCaptureVideoPreviewLayer
        }
    }
}
