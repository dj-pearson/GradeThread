import AVFoundation
import SwiftUI

/// Modal scanner. Presents the back-camera preview with a centered
/// viewfinder rectangle. On detected code, haptic-feedbacks, calls
/// `onScanned(code)`, and dismisses. Falls through to a clear error
/// surface when the simulator (no camera) or a denied-permission state
/// blocks the live preview.
struct BarcodeScanView: View {
    @Environment(\.dismiss) private var dismiss

    /// Invoked once with the recognized payload string. The scanner is
    /// single-shot per AC; the view dismisses immediately after firing.
    let onScanned: (String) -> Void

    @State private var scanner = BarcodeScanner()
    @State private var permissionState: PermissionState = .unknown
    @State private var startupError: String?
    // US-1408: drives scanner restart on return to foreground.
    @Environment(\.scenePhase) private var scenePhase

    private enum PermissionState: Equatable {
        case unknown
        case granted
        case denied
    }

    var body: some View {
        ZStack {
            cameraLayer
            overlay
        }
        .ignoresSafeArea()
        // US-1408: restart the scanner session on return to foreground — iOS
        // stops it on background / call and won't auto-resume, and this view's
        // one-shot `.task` won't re-fire. Idempotent with the session's own
        // interruption self-heal.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { scanner.restartIfNeeded() }
        }
        .task { await bootstrap() }
        .onDisappear { scanner.stop() }
    }

    @ViewBuilder
    private var cameraLayer: some View {
        switch permissionState {
        case .granted:
            CameraPreview(session: scanner.session)
                .background(Color.black)
        case .denied:
            permissionDeniedView
        case .unknown:
            ZStack {
                Color.black
                if let startupError {
                    Text(startupError)
                        .foregroundStyle(.white)
                        .multilineTextAlignment(.center)
                        .padding()
                } else {
                    ProgressView().tint(.white)
                }
            }
        }
    }

    private var overlay: some View {
        VStack {
            HStack {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .scaledIconFont(size: 18, weight: .semibold)
                        .foregroundStyle(.white)
                        .padding(12)
                        .background(.black.opacity(0.45))
                        .clipShape(Circle())
                }
                .accessibilityLabel("Close")
                Spacer()
                Text("Scan barcode")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(.black.opacity(0.45))
                    .clipShape(Capsule())
                Spacer()
                Color.clear.frame(width: 42, height: 42)
            }
            .padding(.horizontal, 16)
            .padding(.top, 24)

            Spacer()
            viewfinder
            Spacer()

            Text("Hold the barcode inside the frame")
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.85))
                .padding(.bottom, 32)
        }
    }

    private var viewfinder: some View {
        // 280×120 frame fits both EAN/UPC strip codes and QR squares
        // comfortably without aggressive zoom.
        RoundedRectangle(cornerRadius: CornerRadius.card, style: .continuous)
            .stroke(.white.opacity(0.9), lineWidth: 3)
            .frame(width: 280, height: 120)
            .shadow(color: .black.opacity(0.5), radius: 4)
    }

    private var permissionDeniedView: some View {
        VStack(spacing: 18) {
            Image(systemName: "camera.fill")
                .font(.system(size: 48, weight: .light))
                .foregroundStyle(.white)
            Text("Camera access is off")
                .font(.brandTitle2)
                .foregroundStyle(.white)
            Text("Turn it on in Settings to scan SKU barcodes.")
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(.white.opacity(0.8))
                .padding(.horizontal, 32)
            if let settingsURL = URL(string: UIApplication.openSettingsURLString) {
                Link(destination: settingsURL) {
                    Text("Open Settings")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 10)
                        .background(Color.brandNavy)
                        .clipShape(Capsule())
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black)
    }

    // MARK: - Lifecycle

    private func bootstrap() async {
        do {
            try await scanner.start()
            permissionState = .granted
            // One detection wins. The dedupe window in BarcodeScanner
            // already guards against duplicate emits, but we also break
            // out of the loop on first yield so the scanner stops
            // emitting after the user's first successful scan.
            for await code in scanner.detections() {
                let generator = UINotificationFeedbackGenerator()
                generator.prepare()
                generator.notificationOccurred(.success)
                onScanned(code)
                dismiss()
                break
            }
        } catch BarcodeScanner.BarcodeError.permissionDenied {
            permissionState = .denied
        } catch {
            // US-1181: friendly copy (matching PhotoIntakeView.bootstrap) instead
            // of the raw, often-cryptic localizedDescription.
            Telemetry.breadcrumb("Barcode scanner start failed: \(FriendlyErrorCopy.rawDetail(for: error))", category: "capture")
            startupError = FriendlyErrorCopy.actionMessage(
                for: error,
                fallback: "Couldn't start the scanner. Please try again."
            )
        }
    }
}
